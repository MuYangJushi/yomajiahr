/**
 * Shared YAML frontmatter parsing and rewriting utilities.
 *
 * Used by: server.mjs, doc-to-markdown.mjs CLI
 */

/**
 * Parse YAML frontmatter from a Markdown string into a plain object.
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }
  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return meta;
}

/**
 * Overwrite specific frontmatter fields in a Markdown string, preserving key order.
 * @param {string} markdown
 * @param {Record<string, string | number | undefined | null>} updates
 * @returns {string}
 */
export function overwriteFrontmatter(markdown, updates) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return markdown;
  }
  const meta = parseFrontmatter(markdown);
  const nextMeta = {
    ...meta,
    ...Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined && value !== null),
    ),
  };
  const orderedKeys = [
    "title",
    "source_file",
    "source_format",
    "doc_id",
    "version",
    "effective_date",
    "category",
    "converted_date",
    "total_pages",
  ];
  const rendered = orderedKeys
    .filter((key) => key in nextMeta && String(nextMeta[key]).trim() !== "")
    .map((key) => `${key}: "${String(nextMeta[key]).replaceAll('"', '\\"')}"`);
  if ("total_pages" in nextMeta && String(nextMeta.total_pages).trim() !== "") {
    const idx = rendered.findIndex((line) => line.startsWith('total_pages: "'));
    if (idx >= 0) {
      const totalPages = String(nextMeta.total_pages);
      rendered[idx] = `total_pages: ${totalPages}`;
    }
  }
  const replacement = `---\n${rendered.join("\n")}\n---`;
  return markdown.replace(/^---\n[\s\S]*?\n---/, replacement);
}
