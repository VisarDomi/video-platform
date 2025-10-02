# tslive-auth
Get and update tokens used by other tslive microservices.

## note
don't activate two instances with different credentials, as they will write to the same file
`sharedStatePath: path.join(os.homedir(), ".local", "share", "tslive-services"),`

```
return path.resolve(config.getConfig().sharedStatePath, `session.json`);
```
