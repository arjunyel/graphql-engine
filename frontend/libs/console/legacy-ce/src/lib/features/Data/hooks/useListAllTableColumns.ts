import { useTableColumns } from '@/features/BrowseRows';
import { TableColumn } from '@/features/DataSource';
import { MetadataSelectors, useMetadata } from '@/features/hasura-metadata-api';
import { MetadataTableColumnConfig } from '@/features/hasura-metadata-types';
import { UseQueryResult } from 'react-query';

export type ListAllTableColumnsReturn = {
  columns: (TableColumn & { config: MetadataTableColumnConfig | undefined })[];
} & Omit<UseQueryResult, 'data'>;

export const useListAllTableColumns = (
  dataSourceName: string,
  table: unknown
): ListAllTableColumnsReturn => {
  const { data: tableColumns } = useTableColumns({
    table,
    dataSourceName,
  });

  const { data: metadataTable, ...rest } = useMetadata(
    MetadataSelectors.findTable(dataSourceName, table)
  );

  const tableConfig = metadataTable?.configuration?.column_config;

  return {
    columns: (tableColumns?.columns ?? []).map(tableColumn => ({
      ...tableColumn,
      config: tableConfig?.[tableColumn.name],
    })),
    ...rest,
  };
};
