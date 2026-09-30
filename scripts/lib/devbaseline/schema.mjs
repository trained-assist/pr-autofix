// Minimal JSON Schema validator — the subset the devbaseline contracts use:
// type, const, enum, required, properties, additionalProperties, items, pattern, minimum.
//
// Why not a dependency: pr-autofix runs as a GitHub Action with zero install steps, and the
// contracts are deliberately small. A full validator would be an install step and a supply
// chain in every consumer repo, for the sake of ~90 lines of spec. If a contract ever needs
// $ref/anyOf/allOf/oneOf, this module is the thing to replace — and that replacement is a
// deliberate act, not an accident of drift.

const TYPE_OK = {
  object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: v => typeof v === 'string',
  integer: v => Number.isInteger(v),
  number: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  null: v => v === null,
};

function typeMatches(expected, value) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some(t => (TYPE_OK[t] ? TYPE_OK[t](value) : true));
}

function validateNode(schema, value, at, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push({ path: at || '(root)', keyword: 'type', message: `expected ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}` });
    return;
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path: at || '(root)', keyword: 'const', message: `expected ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path: at || '(root)', keyword: 'enum', message: `expected one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}` });
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push({ path: at || '(root)', keyword: 'pattern', message: `does not match /${schema.pattern}/` });
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push({ path: at || '(root)', keyword: 'minimum', message: `>= ${schema.minimum} expected` });
  }

  if (TYPE_OK.array(value) && schema.items) {
    value.forEach((item, i) => validateNode(schema.items, item, `${at}[${i}]`, errors));
  }

  if (TYPE_OK.object(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: at ? `${at}.${key}` : key, keyword: 'required', message: 'required property is missing' });
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) validateNode(sub, value[key], at ? `${at}.${key}` : key, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push({ path: at ? `${at}.${key}` : key, keyword: 'additionalProperties', message: 'unknown property' });
      }
    }
  }
}

/** @returns {{valid: boolean, errors: {path: string, keyword: string, message: string}[]}} */
export function validateAgainstSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}