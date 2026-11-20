// A file host for the tests, shaped like a real one: file pages on two domains
// (https://files.example/f/<id>, https://files.test/f/<id>), a download button naming the
// file's number, a metadata API and a signing service that make the media URL on a CDN.
import { createHash } from 'node:crypto';

const PAGES = new Set(['files.example', 'files.test']);

function page(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || !PAGES.has(url.hostname) || url.port || url.username || url.password
        || !/^\/f\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return null;
    url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
    return url;
}
const allowed = (url) => PAGES.has(url.hostname) || url.hostname === 'dl.files.example'
    || url.hostname === 'sign.files.example' || /^[a-z0-9-]+\.cdn\.files\.example$/.test(url.hostname);

export const host = {
    id: 'file-host',
    label: 'File host',
    fileHost: {
        canonicalPage: (value) => page(value)?.href ?? null,
        isAllowedHost: allowed,
        async resolve(source, http) {
            const html = await http.text(source);
            const link = html.match(/href="(https:\/\/dl\.files\.example\/file\/\d+)"/)?.[1];
            if (!link) throw new Error('download button not found');
            const download = new URL(link);
            const meta = JSON.parse(await http.text(`${download.origin}/api/file`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: download.pathname.split('/').at(-1) }) }));
            const media = new URL(meta.mediafiles + meta.path);
            if (media.protocol !== 'https:' || !allowed(media)) throw new Error('Unsupported File host download host');
            const signed = JSON.parse(await http.text(`https://sign.files.example/sign?path=${encodeURIComponent(media.pathname)}`));
            media.searchParams.set('token', signed.token);
            return { url: media.href, filename: meta.original };
        },
        jobKey: (value) => createHash('sha256').update(new URL(value).pathname).digest('hex').slice(0, 24),
    },
};
