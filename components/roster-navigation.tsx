import Form from "next/form";
import Link from "next/link";
import { ROSTER_PAGE_SIZE, rosterPageHref, type RosterCategoryOption, type RosterFilters } from "@/lib/roster-pagination";

type NavigationProps = {
  eventId: string;
  filters: RosterFilters;
  count: number;
  page: number;
  pages: number;
};

export function RosterFiltersForm({ eventId, filters, distances, categories }: {
  eventId: string;
  filters: RosterFilters;
  distances: string[];
  categories: RosterCategoryOption[];
}) {
  const sexes = [
    ["F", "Femenino"], ["M", "Masculino"], ["otro", "Otro"],
    ["no_informado", "No informado"], ["unspecified", "Sin dato registrado"],
  ];
  return <div className="panel-body roster-search" key={rosterPageHref(eventId, filters)}>
    <Form action={`/admin/events/${encodeURIComponent(eventId)}`} scroll={false} prefetch={false} className="roster-filter-form">
      <input type="hidden" name="tab" value="roster" />
      <label>Dorsal<input name="roster_bib" defaultValue={filters.bib} maxLength={50} placeholder="Buscar dorsal" /></label>
      <label>Chip / EPC<input name="roster_chip" defaultValue={filters.chip} maxLength={128} placeholder="Buscar chip" /></label>
      <label>Sexo<select name="roster_sex" defaultValue={filters.sex}>
        <option value="">Todos</option>{sexes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Distancia<select name="roster_distance" defaultValue={filters.distance}>
        <option value="">Todas</option>{distances.map((distance) => <option key={distance} value={distance}>{distance}</option>)}
      </select></label>
      <label>Categoría<select name="roster_category" defaultValue={filters.category}>
        <option value="">Todas</option>
        {filters.category && !categories.some((category) => category.value === filters.category) && <option value={filters.category}>Categoría no disponible</option>}
        {categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
      </select></label>
      <button className="button button-dark button-small">Aplicar filtros</button>
      <Link href={`/admin/events/${encodeURIComponent(eventId)}?tab=roster`} prefetch={false} scroll={false} className="button button-quiet button-small">Limpiar</Link>
    </Form>
    <p className="setting-caption">Dorsal y chip permiten coincidencias parciales. Los filtros se combinan y buscan en toda la nómina.</p>
  </div>;
}

export function RosterPagination({ eventId, filters, count, page, pages }: NavigationProps) {
  const start = count ? (page - 1) * ROSTER_PAGE_SIZE + 1 : 0;
  const end = Math.min(page * ROSTER_PAGE_SIZE, count);
  return <nav className="panel-body roster-pagination" aria-label="Páginas de la nómina">
    <span role="status">Mostrando {start}–{end} de {count} participantes · Página {page} de {pages}</span>
    <div className="row-actions">
      {page > 1 ? <Link href={rosterPageHref(eventId, filters, page - 1)} prefetch={false} scroll={false} className="button button-quiet button-small">Anterior</Link>
        : <span className="button button-quiet button-small" aria-disabled="true">Anterior</span>}
      {page < pages ? <Link href={rosterPageHref(eventId, filters, page + 1)} prefetch={false} scroll={false} className="button button-quiet button-small">Siguiente</Link>
        : <span className="button button-quiet button-small" aria-disabled="true">Siguiente</span>}
    </div>
  </nav>;
}
