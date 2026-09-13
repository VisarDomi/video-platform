export interface XhrResult {
    status: number;
    text: string;
}

export function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<XhrResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(init.method ?? "GET", url);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json; charset=UTF-8");
        for (const [name, value] of Object.entries(init.headers ?? {})) {
            xhr.setRequestHeader(name, value);
        }
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () => reject(new Error(`Request failed: ${url}`));
        xhr.send(init.body ?? null);
    });
}


export const fetchResponse: typeof fetch = (...args) => fetch(...args);
