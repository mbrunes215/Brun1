import type { Category } from "@/domain/types";

export function CategoryOptions({ categories, includeNone = true }: { categories: Array<Category & { archived?: boolean }>; includeNone?: boolean }) {
  const groups = new Map<string, Category[]>();
  for (const c of categories) {
    if ((c as { archived?: boolean }).archived) continue;
    (groups.get(c.group) ?? groups.set(c.group, []).get(c.group)!).push(c);
  }
  return (
    <>
      {includeNone && <option value="">Uncategorized</option>}
      {[...groups.entries()].map(([g, cs]) => (
        <optgroup key={g} label={g}>
          {cs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
