// Escaping DOM helpers.
//
// ADR 0001 chose plain ES modules with no build step, which means no JSX and therefore a real risk
// of escaping mistakes. Everything that builds markup goes through `html`, which escapes every
// interpolated value by default. Trusted fragments must opt in explicitly via `raw`, so an XSS bug
// requires somebody to type the word `raw` rather than merely forgetting to escape.
//
// Never assign to innerHTML directly. Use `mount` or `toFragment`.

const RAW = Symbol("raw");

const ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

/**
 * Mark a string as already-safe HTML. Only for markup this codebase produced —
 * never for anything that came from the database or a form field.
 */
export function raw(value) {
  return { [RAW]: String(value) };
}

export function isRaw(value) {
  return Boolean(value) && typeof value === "object" && RAW in value;
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (isRaw(value)) return value[RAW];
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(value);
}

/**
 * Tagged template producing safe HTML.
 *
 *   html`<p>${name}</p>`                  // name is escaped
 *   html`<ul>${items.map(li)}</ul>`       // arrays are flattened, each item rendered
 *   html`<div>${raw(trustedMarkup)}</div>`// opt out, deliberately
 *
 * Returns a raw marker so results nest without double-escaping.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1];
  }
  return raw(out);
}

/** Turn an `html` result into a DocumentFragment. */
export function toFragment(result) {
  const template = document.createElement("template");
  template.innerHTML = render(result);
  return template.content;
}

/** Replace an element's children with rendered markup. */
export function mount(element, result) {
  element.replaceChildren(toFragment(result));
  return element;
}

/** Shorthand for querySelector that throws rather than returning null silently. */
export function el(selector, root = document) {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`element not found: ${selector}`);
  return found;
}
