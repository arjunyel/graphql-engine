{-# LANGUAGE ViewPatterns #-}

-- | The RQL query ('/v2/query')
module Hasura.Server.API.V2Query
  ( RQLQuery,
    queryModifiesSchema,
    runQuery,
  )
where

import Control.Concurrent.Async.Lifted (mapConcurrently)
import Control.Lens (preview, _Right)
import Control.Monad.Trans.Control (MonadBaseControl)
import Data.Aeson
import Data.Aeson.Types (Parser)
import Data.Environment qualified as Env
import Data.Text qualified as T
import GHC.Generics.Extended (constrName)
import Hasura.Backends.BigQuery.DDL.RunSQL qualified as BigQuery
import Hasura.Backends.DataConnector.Adapter.RunSQL qualified as DataConnector
import Hasura.Backends.DataConnector.Adapter.Types (DataConnectorName, mkDataConnectorName)
import Hasura.Backends.MSSQL.DDL.RunSQL qualified as MSSQL
import Hasura.Backends.MySQL.SQL qualified as MySQL
import Hasura.Backends.Postgres.DDL.RunSQL qualified as Postgres
import Hasura.Base.Error
import Hasura.EncJSON
import Hasura.GraphQL.Execute.Backend
import Hasura.Metadata.Class
import Hasura.Prelude
import Hasura.RQL.DDL.Schema
import Hasura.RQL.DML.Count
import Hasura.RQL.DML.Delete
import Hasura.RQL.DML.Insert
import Hasura.RQL.DML.Select
import Hasura.RQL.DML.Types
  ( CountQuery,
    DeleteQuery,
    InsertQuery,
    SelectQuery,
    UpdateQuery,
  )
import Hasura.RQL.DML.Update
import Hasura.RQL.Types.Metadata
import Hasura.RQL.Types.Run
import Hasura.RQL.Types.SchemaCache.Build
import Hasura.RQL.Types.Source
import Hasura.SQL.Backend
import Hasura.Server.Types
import Hasura.Session
import Hasura.Tracing qualified as Tracing
import Language.GraphQL.Draft.Syntax qualified as GQL
import Network.HTTP.Client qualified as HTTP

data RQLQuery
  = RQInsert !InsertQuery
  | RQSelect !SelectQuery
  | RQUpdate !UpdateQuery
  | RQDelete !DeleteQuery
  | RQCount !CountQuery
  | RQRunSql !Postgres.RunSQL
  | RQMssqlRunSql !MSSQL.MSSQLRunSQL
  | RQCitusRunSql !Postgres.RunSQL
  | RQCockroachRunSql !Postgres.RunSQL
  | RQMysqlRunSql !MySQL.RunSQL
  | RQBigqueryRunSql !BigQuery.BigQueryRunSQL
  | RQDataConnectorRunSql !DataConnectorName !DataConnector.DataConnectorRunSQL
  | RQBigqueryDatabaseInspection !BigQuery.BigQueryRunSQL
  | RQBulk ![RQLQuery]
  | -- | A variant of 'RQBulk' that runs a bulk of read-only queries concurrently.
    --   Asserts that queries on this lists are not modifying the schema.
    --
    --   This is mainly used by the graphql-engine console.
    RQConcurrentBulk [RQLQuery]
  deriving (Generic)

-- | This instance has been written by hand so that "wildcard" prefixes of _run_sql can be delegated to data connectors.
instance FromJSON RQLQuery where
  parseJSON = withObject "RQLQuery" \o -> do
    t <- o .: "type"
    let args :: forall a. FromJSON a => Parser a
        args = o .: "args"
        dcNameFromRunSql = T.stripSuffix "_run_sql" >=> GQL.mkName >=> preview _Right . mkDataConnectorName
    case t of
      "insert" -> RQInsert <$> args
      "select" -> RQSelect <$> args
      "update" -> RQUpdate <$> args
      "delete" -> RQDelete <$> args
      "count" -> RQCount <$> args
      -- Optionally, we can specify a `pg_` prefix. This primarily makes some
      -- string interpolation easier in the cross-backend tests.
      "run_sql" -> RQRunSql <$> args
      "pg_run_sql" -> RQRunSql <$> args
      "mssql_run_sql" -> RQMssqlRunSql <$> args
      "citus_run_sql" -> RQCitusRunSql <$> args
      "cockroach_run_sql" -> RQCockroachRunSql <$> args
      "mysql_run_sql" -> RQMysqlRunSql <$> args
      "bigquery_run_sql" -> RQBigqueryRunSql <$> args
      (dcNameFromRunSql -> Just t') -> RQDataConnectorRunSql t' <$> args
      "bigquery_database_inspection" -> RQBigqueryDatabaseInspection <$> args
      "bulk" -> RQBulk <$> args
      "concurrent_bulk" -> RQConcurrentBulk <$> args
      _ -> fail $ "Unrecognised RQLQuery type: " <> T.unpack t

runQuery ::
  ( MonadIO m,
    MonadBaseControl IO m,
    MonadError QErr m,
    Tracing.MonadTrace m,
    MonadMetadataStorage m,
    MonadResolveSource m,
    MonadQueryTags m
  ) =>
  Env.Environment ->
  InstanceId ->
  UserInfo ->
  RebuildableSchemaCache ->
  HTTP.Manager ->
  ServerConfigCtx ->
  RQLQuery ->
  m (EncJSON, RebuildableSchemaCache)
runQuery env instanceId userInfo schemaCache httpManager serverConfigCtx rqlQuery = do
  when ((_sccReadOnlyMode serverConfigCtx == ReadOnlyModeEnabled) && queryModifiesUserDB rqlQuery) $
    throw400 NotSupported "Cannot run write queries when read-only mode is enabled"

  (metadata, currentResourceVersion) <- Tracing.trace "fetchMetadata" $ liftEitherM fetchMetadata
  result <-
    runQueryM env rqlQuery & \x -> do
      ((js, meta), rsc, ci) <-
        -- We can use defaults here unconditionally, since there is no MD export function in V2Query
        x
          & runMetadataT metadata (_sccMetadataDefaults serverConfigCtx)
          & runCacheRWT schemaCache
          & peelRun runCtx
      pure (js, rsc, ci, meta)
  withReload currentResourceVersion result
  where
    runCtx = RunCtx userInfo httpManager serverConfigCtx

    withReload currentResourceVersion (result, updatedCache, invalidations, updatedMetadata) = do
      when (queryModifiesSchema rqlQuery) $ do
        case _sccMaintenanceMode serverConfigCtx of
          MaintenanceModeDisabled -> do
            -- set modified metadata in storage
            newResourceVersion <-
              Tracing.trace "setMetadata" $
                liftEitherM $
                  setMetadata currentResourceVersion updatedMetadata
            -- notify schema cache sync
            Tracing.trace "notifySchemaCacheSync" $
              liftEitherM $
                notifySchemaCacheSync newResourceVersion instanceId invalidations
          MaintenanceModeEnabled () ->
            throw500 "metadata cannot be modified in maintenance mode"
      pure (result, updatedCache)

queryModifiesSchema :: RQLQuery -> Bool
queryModifiesSchema = \case
  RQInsert _ -> False
  RQSelect _ -> False
  RQUpdate _ -> False
  RQDelete _ -> False
  RQCount _ -> False
  RQRunSql q -> Postgres.isSchemaCacheBuildRequiredRunSQL q
  RQCitusRunSql q -> Postgres.isSchemaCacheBuildRequiredRunSQL q
  RQCockroachRunSql q -> Postgres.isSchemaCacheBuildRequiredRunSQL q
  RQMssqlRunSql q -> MSSQL.isSchemaCacheBuildRequiredRunSQL q
  RQMysqlRunSql _ -> False
  RQBigqueryRunSql _ -> False
  RQDataConnectorRunSql _ _ -> False
  RQBigqueryDatabaseInspection _ -> False
  RQBulk l -> any queryModifiesSchema l
  RQConcurrentBulk l -> any queryModifiesSchema l

runQueryM ::
  ( MonadError QErr m,
    MonadIO m,
    MonadBaseControl IO m,
    UserInfoM m,
    CacheRWM m,
    HasServerConfigCtx m,
    Tracing.MonadTrace m,
    MetadataM m,
    MonadQueryTags m
  ) =>
  Env.Environment ->
  RQLQuery ->
  m EncJSON
runQueryM env rq = Tracing.trace (T.pack $ constrName rq) $ case rq of
  RQInsert q -> runInsert q
  RQSelect q -> runSelect q
  RQUpdate q -> runUpdate q
  RQDelete q -> runDelete q
  RQCount q -> runCount q
  RQRunSql q -> Postgres.runRunSQL @'Vanilla q
  RQMssqlRunSql q -> MSSQL.runSQL q
  RQMysqlRunSql q -> MySQL.runSQL q
  RQCitusRunSql q -> Postgres.runRunSQL @'Citus q
  RQCockroachRunSql q -> Postgres.runRunSQL @'Cockroach q
  RQBigqueryRunSql q -> BigQuery.runSQL q
  RQDataConnectorRunSql t q -> DataConnector.runSQL t q
  RQBigqueryDatabaseInspection q -> BigQuery.runDatabaseInspection q
  RQBulk l -> encJFromList <$> indexedMapM (runQueryM env) l
  RQConcurrentBulk l -> do
    when (queryModifiesSchema rq) $
      throw500 "Only read-only queries are allowed in a concurrent_bulk"
    encJFromList <$> mapConcurrently (runQueryM env) l

queryModifiesUserDB :: RQLQuery -> Bool
queryModifiesUserDB = \case
  RQInsert _ -> True
  RQSelect _ -> False
  RQUpdate _ -> True
  RQDelete _ -> True
  RQCount _ -> False
  RQRunSql _ -> True
  RQCitusRunSql _ -> True
  RQCockroachRunSql _ -> True
  RQMssqlRunSql _ -> True
  RQMysqlRunSql _ -> True
  RQBigqueryRunSql _ -> True
  RQDataConnectorRunSql _ _ -> True
  RQBigqueryDatabaseInspection _ -> False
  RQBulk q -> any queryModifiesUserDB q
  RQConcurrentBulk _ -> False
