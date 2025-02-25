import { DataSource } from '@/features/DataSource';
import { generateGraphQLInsertMutation } from '@/features/GraphQLUtils';
import { areTablesEqual, useMetadata } from '@/features/hasura-metadata-api';
import { Table } from '@/features/hasura-metadata-types';
import { useHttpClient } from '@/features/Network';
import { useGraphQLMutation } from './useGraphQLMutation';

export type FormData = Record<
  string,
  | {
      option: 'value';
      value: unknown;
    }
  | { option: 'default' }
  | { option: 'null' }
>;

type UseInsertRowProps = {
  table: Table;
  dataSourceName: string;
  onSuccess?: () => void;
  onError?: (err: Error) => void;
};

export const useInsertRow = ({
  table,
  dataSourceName,
  onSuccess,
  onError,
}: UseInsertRowProps) => {
  const { data } = useMetadata(m => ({
    sourceCustomization: m.metadata.sources?.find(
      s => s.name === dataSourceName
    )?.customization,
    tableCustomization: m.metadata.sources
      ?.find(s => s.name === dataSourceName)
      ?.tables.find(t => areTablesEqual(t.table, table))?.configuration,
  }));

  const httpClient = useHttpClient();

  const { mutate, ...rest } = useGraphQLMutation({
    operationName: 'insertRow',
    onSuccess,
    onError,
  });

  const insertRow = async (values: FormData) => {
    const defaultQueryRoot = await DataSource(httpClient).getDefaultQueryRoot({
      dataSourceName,
      table,
    });

    const gqlQuery = generateGraphQLInsertMutation({
      defaultQueryRoot,
      tableCustomization: data?.tableCustomization,
      sourceCustomization: data?.sourceCustomization,
      objects: [
        Object.entries(values).reduce((acc, val) => {
          const [columnName, body] = val;

          if (body.option === 'value')
            return {
              ...acc,
              [columnName]: body.value,
            };

          return acc;
        }, {}),
      ],
      mutationName: 'insertRow',
    });

    return mutate(gqlQuery);
  };

  return { insertRow, ...rest };
};
