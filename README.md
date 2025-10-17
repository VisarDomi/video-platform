# tslive-auth
Get and update tokens used by other tslive microservices.

## note
this service produces:

`sharedStatePath: path.join(os.homedir(), ".local", "share", "video-services"),`

`
return path.resolve(config.getConfig().sharedStatePath, `session.json`);
`

hence, don't activate two instances with different credentials, as they will write to the same file. this case needs more development
