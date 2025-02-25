import { useState, useCallback } from 'react';
import { programmaticallyTraceError } from '@/features/Analytics';
import { Dispatch } from '@/types';
import {
  setDBURLInEnvVars,
  verifyProjectHealthAndConnectDataSource,
} from '../utils';
import { NeonIntegrationContext } from './utils';
import { setDBConnectionDetails } from '../../../DataActions';
import {
  connectDataSource,
  connectionTypes,
  getDefaultState,
} from '../../../DataSources/state';

type HasuraDBCreationPayload = {
  envVar: string;
  dataSourceName: string;
};

// this hook must never go into an error
type HasuraDatasourceStatus =
  | {
      status: 'idle';
    }
  | {
      status: 'adding-env-var';
    }
  | {
      status: 'adding-data-source';
      payload: HasuraDBCreationPayload;
    }
  | {
      status: 'success';
      payload: HasuraDBCreationPayload;
    }
  | {
      status: 'adding-env-var-failed';
      payload: {
        dbUrl: string;
      };
    }
  | {
      status: 'adding-data-source-failed';
      payload: HasuraDBCreationPayload;
    };

export function useCreateHasuraCloudDatasource(
  dbUrl: string,
  dataSourceName = 'default',
  dispatch: Dispatch,
  context: NeonIntegrationContext
) {
  const [state, setState] = useState<HasuraDatasourceStatus>({
    status: 'idle',
  });

  // this function adds an ENV var database to Hasura
  const executeConnect = useCallback(
    (
      envVar: string,
      successCallback: VoidFunction,
      errorCallback: VoidFunction
    ) => {
      setState({
        status: 'adding-data-source',
        payload: {
          envVar,
          dataSourceName,
        },
      });

      const connectionConfig = {
        envVar,
        dbName: dataSourceName,
      };

      dispatch(setDBConnectionDetails(connectionConfig));
      try {
        connectDataSource(
          dispatch,
          connectionTypes.ENV_VAR,
          getDefaultState({
            dbConnection: connectionConfig,
          }),
          successCallback,
          undefined,
          undefined,
          undefined,
          undefined,
          context === 'data-manage-create'
        );
      } catch (e) {
        errorCallback();
      }
    },
    [dataSourceName, dbUrl]
  );

  const start = useCallback(() => {
    if (dbUrl) {
      setState({
        status: 'adding-env-var',
      });

      // This sets the database URL of the given Hasura project as an env var in Hasura Cloud project
      setDBURLInEnvVars(dbUrl)
        .then(envVar => {
          setState({
            status: 'adding-data-source',
            payload: {
              envVar,
              dataSourceName,
            },
          });
          /*
            There's a downtime after env var updation.
            So we verify the project health and attempt connecting datasource only after project is up
            We start verifying the project health after a timeout of 5000 seconds,
            because it could 2-3 seconds for the project to go down after the environment variable update
          */
          setTimeout(() => {
            verifyProjectHealthAndConnectDataSource(
              () => {
                executeConnect(
                  envVar,
                  // set success status when the data source gets added successfully
                  () => {
                    setState({
                      status: 'success',
                      payload: {
                        envVar,
                        dataSourceName,
                      },
                    });
                  },
                  // set error status when the data source gets added successfully
                  () => {
                    setState({
                      status: 'adding-data-source-failed',
                      payload: {
                        envVar,
                        dataSourceName,
                      },
                    });
                  }
                );
              },
              // set error status if creating env var failed
              () => {
                setState({
                  status: 'adding-data-source-failed',
                  payload: {
                    envVar,
                    dataSourceName,
                  },
                });
              }
            );
          }, 5000);
        })
        .catch(error => {
          // if adding env var fails unexpectedly, set the error state
          setState(prevState => {
            if (prevState.status === 'adding-env-var') {
              // this is an unexpected error; so we need alerts about this
              programmaticallyTraceError({
                error: 'Failed creating env vars in Hasura',
                cause: error,
              });
              return {
                status: 'adding-env-var-failed',
                payload: { dbUrl },
              };
              // if adding data-source fails unexpectedly, set the error state
            } else if (prevState.status === 'adding-data-source') {
              // this is an unexpected error; so we need alerts about this
              programmaticallyTraceError({
                error: 'Failed adding created data source in Hasura',
                cause: error,
              });

              return {
                status: 'adding-data-source-failed',
                payload: prevState.payload,
              };
            }
            return prevState;
          });
        });
    }
  }, [dbUrl, dataSourceName, state]);

  return {
    state,
    addHasuraDatasource: start,
  };
}
