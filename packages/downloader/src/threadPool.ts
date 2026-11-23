// Imported first by main.ts, before anything uses libuv's thread pool (which reads its size
// once, when it starts). The pool runs file system calls and DNS lookups: with the default
// four threads, four segment fsyncs stalled on a slow disk would leave none for the playlist
// poll's lookup and the token read, so polling would wait on the very disk it must not wait on.
process.env.UV_THREADPOOL_SIZE ??= "32";
export {};
