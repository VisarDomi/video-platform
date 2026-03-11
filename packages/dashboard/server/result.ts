export type Result<T, E = string> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

export function Ok<T>(value: T): Result<T, never> {
	return Object.freeze({ ok: true as const, value });
}

export function Err<E = string>(error: E): Result<never, E> {
	return Object.freeze({ ok: false as const, error });
}
