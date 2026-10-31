import { useMemo, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState, type Table } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePhone } from '@/hooks/use-media-query';
import { Button } from './ui/button';
import { EmptyState, Skeleton } from './ui/misc';

export type Column<T> = ColumnDef<T, unknown> & {
  meta?: {
    className?: string;
    sortKey?: string;
    align?: 'right' | 'center';
    /**
     * Phone card layout: 'primary' is the card's main line (default: the first
     * column), 'secondary' a small line above it, 'hide' leaves it out.
     */
    mobile?: 'primary' | 'secondary' | 'hide';
  };
};

export interface Sort {
  sort?: string;
  order: 'asc' | 'desc';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[] | undefined;
  total?: number;
  page?: number;
  pageSize?: number;
  loading?: boolean;
  sort?: Sort;
  onSortChange?: (s: Sort) => void;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T, e: React.MouseEvent) => void;
  rowHref?: (row: T) => string;
  selectable?: boolean;
  selection?: RowSelectionState;
  onSelectionChange?: (s: RowSelectionState) => void;
  getRowId?: (row: T) => string;
  empty?: ReactNode;
  className?: string;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
}

/**
 * Compact server-driven table: sorting and pagination are delegated to the
 * caller (which passes them to the API); rows can link to record pages.
 */
export function DataTable<T>({
  columns,
  data,
  total = 0,
  page = 1,
  pageSize = 50,
  loading,
  sort,
  onSortChange,
  onPageChange,
  onRowClick,
  selectable,
  selection,
  onSelectionChange,
  getRowId,
  empty,
  className,
  dense = true,
  rowClassName,
}: DataTableProps<T>) {
  const cols = useMemo<Column<T>[]>(() => {
    if (!selectable) return columns;
    return [
      {
        id: '__select',
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all"
            className="size-3.5 cursor-pointer accent-[var(--primary)]"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label="Select row"
            className="size-3.5 cursor-pointer accent-[var(--primary)]"
            checked={row.getIsSelected()}
            onClick={(e) => e.stopPropagation()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
        meta: { className: 'w-8' },
      },
      ...columns,
    ];
  }, [columns, selectable]);

  const table = useReactTable({
    data: data ?? [],
    columns: cols,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: selectable,
    state: { rowSelection: selection ?? {} },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(selection ?? {}) : updater;
      onSelectionChange?.(next);
    },
    getRowId: getRowId ? (r) => getRowId(r) : undefined,
  });

  const phone = usePhone();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <CardList table={table} loading={loading} hasData={!!data?.length} onRowClick={onRowClick} rowClassName={rowClassName} sort={sort} onSortChange={onSortChange} />
          {!loading && data && data.length === 0 && (empty ?? <EmptyState title="No records found" description="Try adjusting the filters." />)}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = (h.column.columnDef as Column<T>).meta;
                  const sortKey = meta?.sortKey;
                  const active = sortKey && sort?.sort === sortKey;
                  return (
                    <th
                      key={h.id}
                      className={cn(
                        'whitespace-nowrap border-b border-border bg-surface-2 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted',
                        meta?.align === 'right' && 'text-right',
                        meta?.className,
                      )}
                    >
                      {sortKey && onSortChange ? (
                        <button
                          className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-foreground"
                          onClick={() => onSortChange({ sort: sortKey, order: active && sort?.order === 'asc' ? 'desc' : 'asc' })}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {active ? sort?.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading && !data?.length
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {cols.map((_c, j) => (
                      <td key={j} className="border-b border-border px-3 py-2">
                        <Skeleton className="h-3.5 w-full max-w-40" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? (e) => onRowClick(row.original, e) : undefined}
                    className={cn(
                      'group bg-surface transition-colors',
                      onRowClick && 'cursor-pointer hover:bg-surface-2',
                      row.getIsSelected() && 'bg-primary-soft/60',
                      rowClassName?.(row.original),
                    )}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = (cell.column.columnDef as Column<T>).meta;
                      return (
                        <td
                          key={cell.id}
                          className={cn('border-b border-border px-3 align-middle', dense ? 'py-1.5' : 'py-2.5', meta?.align === 'right' && 'text-right tabular-nums', meta?.className)}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                ))}
          </tbody>
        </table>
        {!loading && data && data.length === 0 && (empty ?? <EmptyState title="No records found" description="Try adjusting the filters." />)}
      </div>
      )}
      {onPageChange && total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-surface px-3 py-1.5 text-xs text-muted">
          <span className="tabular-nums">
            {from}–{to} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              {page} / {pages}
            </span>
            <Button size="icon-sm" variant="ghost" disabled={page >= pages} onClick={() => onPageChange(page + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Phone layout of the table: one card per row. The primary column is the
 * card's title; every other column with a header becomes a small label/value
 * pair, and header-less columns (row actions) go to the card's footer.
 */
function CardList<T>({
  table,
  loading,
  hasData,
  onRowClick,
  rowClassName,
  sort,
  onSortChange,
}: {
  table: Table<T>;
  loading?: boolean;
  hasData: boolean;
  onRowClick?: (row: T, e: React.MouseEvent) => void;
  rowClassName?: (row: T) => string | undefined;
  sort?: Sort;
  onSortChange?: (s: Sort) => void;
}) {
  const headers = table.getFlatHeaders();
  const metaOf = (c: { column: { columnDef: unknown } }) => (c.column.columnDef as Column<T>).meta;
  const headerOf = (id: string) => headers.find((h) => h.column.id === id);
  const label = (id: string): ReactNode => {
    const h = headerOf(id);
    if (!h || id === '__select') return null;
    const def = h.column.columnDef.header;
    if (!def) return null;
    return typeof def === 'string' ? def : flexRender(def, h.getContext());
  };
  const sortable = headers
    .map((h) => ({ key: (h.column.columnDef as Column<T>).meta?.sortKey, text: typeof h.column.columnDef.header === 'string' ? h.column.columnDef.header : '' }))
    .filter((x): x is { key: string; text: string } => !!x.key && !!x.text);

  if (loading && !hasData) {
    return (
      <div className="divide-y divide-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2 bg-surface px-3 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {onSortChange && sortable.length > 0 && hasData && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <span>Sort by</span>
          <select
            className="h-7 min-w-0 flex-1 rounded border border-border bg-surface px-1.5 text-foreground"
            value={sort?.sort ?? ''}
            onChange={(e) => onSortChange({ sort: e.target.value, order: sort?.order ?? 'asc' })}
          >
            {!sort?.sort && <option value="">—</option>}
            {sortable.map((s) => (
              <option key={s.key} value={s.key}>
                {s.text}
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={sort?.order === 'desc' ? 'Sort ascending' : 'Sort descending'}
            disabled={!sort?.sort}
            onClick={() => sort?.sort && onSortChange({ sort: sort.sort, order: sort.order === 'asc' ? 'desc' : 'asc' })}
          >
            {sort?.order === 'desc' ? <ArrowDown /> : <ArrowUp />}
          </Button>
        </div>
      )}
      <ul className="divide-y divide-border">
        {table.getRowModel().rows.map((row) => {
          const cells = row.getVisibleCells().filter((c) => metaOf(c)?.mobile !== 'hide');
          const select = cells.find((c) => c.column.id === '__select');
          const rest = cells.filter((c) => c.column.id !== '__select');
          const primary = rest.find((c) => metaOf(c)?.mobile === 'primary') ?? rest[0];
          const secondary = rest.filter((c) => c !== primary && metaOf(c)?.mobile === 'secondary');
          const others = rest.filter((c) => c !== primary && !secondary.includes(c));
          const labelled = others.filter((c) => label(c.column.id));
          const trailing = others.filter((c) => !label(c.column.id));
          return (
            <li
              key={row.id}
              onClick={onRowClick ? (e) => onRowClick(row.original, e) : undefined}
              className={cn(
                'bg-surface px-3 py-2.5',
                onRowClick && 'cursor-pointer active:bg-surface-2',
                row.getIsSelected() && 'bg-primary-soft/60',
                rowClassName?.(row.original),
              )}
            >
              <div className="flex gap-2.5">
                {select && <div className="pt-0.5">{flexRender(select.column.columnDef.cell, select.getContext())}</div>}
                <div className="min-w-0 flex-1">
                  {secondary.length > 0 && (
                    <div className="mb-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                      {secondary.map((c) => (
                        <span key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</span>
                      ))}
                    </div>
                  )}
                  {primary && <div className="min-w-0 text-[14px]">{flexRender(primary.column.columnDef.cell, primary.getContext())}</div>}
                  {labelled.length > 0 && (
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
                      {labelled.map((c) => (
                        <div key={c.id} className="min-w-0">
                          <dt className="text-[10px] font-medium uppercase tracking-wide text-subtle">{label(c.column.id)}</dt>
                          <dd className="min-w-0 break-words">{flexRender(c.column.columnDef.cell, c.getContext())}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {trailing.length > 0 && (
                    <div className="mt-2 flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {trailing.map((c) => (
                        <span key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
