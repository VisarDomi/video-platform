export interface XhrResponse {
    status: number;
    ok: boolean;
    json(): Promise<any>;
    text(): Promise<string>;
}

export function xhrFetch(url: string, init?: RequestInit): Promise<XhrResponse> {
    const { promise, resolve, reject } = Promise.withResolvers<XhrResponse>();
    const xhr = new XMLHttpRequest();
    xhr.open(init?.method ?? "GET", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
    if (init?.headers) {
        const h = init.headers as Record<string, string>;
        Object.keys(h).forEach(k => xhr.setRequestHeader(k, h[k]));
    }
    xhr.onload = () => resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        json: () => Promise.resolve(JSON.parse(xhr.responseText)),
        text: () => Promise.resolve(xhr.responseText),
    });
    xhr.onerror = () => reject(new Error("XHR network error"));
    xhr.send(init?.body as XMLHttpRequestBodyInit | null ?? null);
    return promise;
}
