import { native } from './native';
export interface XhrResult { status: number; text: string }
export async function request(url: string, init: {method?: string; headers?: Record<string,string>; body?: string} = {}): Promise<XhrResult> {
    return native('request', {url, ...init, headers:{Accept:'application/json; charset=UTF-8', ...init.headers}});
}
export const fetchResponse: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const result = await request(url, {method:init.method, headers:Object.fromEntries(new Headers(init.headers)), body:init.body as string | undefined});
    return new Response(result.text, {status:result.status});
};
