/**
 * Tool parameter schemas in the shape the Anthropic Messages API accepts.
 *
 * The API rejects `oneOf`, `allOf` and `anyOf` at the top level of `input_schema` (HTTP 400 "input_schema does not
 * support oneOf, allOf, or anyOf at the top level"), while tools that take one object per operation are written as
 * exactly such a union. Here the union becomes one object schema: every property any branch declares, required only
 * when every alternative requires it, and a field that is a different constant per branch (`operation`) becomes an
 * `enum`. Unions below the top level are allowed and kept. The arguments are still checked against the tool's full
 * schema when the call runs, so the per-operation rules are enforced there.
 */

type Schema = Record<string, any>;

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = (value: Schema) => Object.keys(value).length === 0;

/** One property schema for a key declared differently by several branches. */
function mergeProperty(existing: Schema | undefined, next: Schema): Schema {
	if (!existing || isEmpty(existing)) return next;
	// `{}` in a branch means "as declared at the top level".
	if (isEmpty(next) || same(existing, next)) return existing;
	const constants = (schema: Schema): unknown[] | undefined =>
		"const" in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined;
	const left = constants(existing);
	const right = constants(next);
	if (left && right) {
		const { const: _a, enum: _b, ...rest } = existing;
		const values = [...left];
		for (const value of right) if (!values.some((known) => same(known, value))) values.push(value);
		return { ...rest, enum: values };
	}
	const options = Array.isArray(existing.anyOf) && Object.keys(existing).length === 1 ? existing.anyOf : [existing];
	return options.some((option: unknown) => same(option, next)) ? existing : { anyOf: [...options, next] };
}

export function toAnthropicInputSchema(schema: Schema): Schema {
	const alternatives = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
	const conjuncts = Array.isArray(schema.allOf) ? (schema.allOf as unknown[]) : [];
	if (!alternatives && conjuncts.length === 0) {
		return { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [] };
	}

	const properties: Schema = { ...(isObject(schema.properties) ? schema.properties : {}) };
	const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
	const take = (branch: Schema) => {
		for (const [key, value] of Object.entries(isObject(branch.properties) ? branch.properties : {})) {
			if (isObject(value)) properties[key] = mergeProperty(properties[key], value);
		}
	};

	for (const branch of conjuncts.filter(isObject)) {
		take(branch);
		for (const key of Array.isArray(branch.required) ? branch.required : []) required.add(key);
	}
	const branches = (alternatives ?? []).filter(isObject);
	branches.forEach(take);
	if (branches.length > 0) {
		const requiredIn = (branch: Schema) => new Set<string>(Array.isArray(branch.required) ? branch.required : []);
		const [first, ...rest] = branches.map(requiredIn);
		for (const key of first) if (rest.every((set) => set.has(key))) required.add(key);
	}

	return { type: "object", properties, required: [...required] };
}
