import {mkdir,open,readFile,stat,unlink} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import path from "node:path";
import os from "node:os";

async function processBirth(pid:number):Promise<string|null>{
    try{const value=await readFile(`/proc/${pid}/stat`,"utf8");const fields=value.slice(value.lastIndexOf(")")+2).split(" ");return fields[0]==="Z"?null:fields[19];}catch{return null;}
}
// PC maintenance and the phone server run in different processes. Initial
// Google authentication is serialized across both; ordinary renewal uses no login.
export async function withLoginLease<T>(email:string,work:()=>Promise<T>,directory=path.join(os.homedir(),".local/state/video-services/tango-login")):Promise<T>{
    await mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,createHash("sha256").update(email).digest("hex")+".lock");
    const nonce=randomUUID(),birth=await processBirth(process.pid),deadline=Date.now()+180_000;
    while(true){
        try{
            const handle=await open(file,"wx",0o600);
            const inode=await handle.stat();
            try{await handle.writeFile(JSON.stringify({pid:process.pid,birth,nonce}));await handle.sync();}finally{await handle.close();}
            if((await stat(file)).ino!==inode.ino)continue;
            break;
        }catch(error:any){
            if(error.code!=="EEXIST")throw error;
            try{
                const inode=await stat(file);let dead=false;
                try{const owner=JSON.parse(await readFile(file,"utf8"));dead=(await processBirth(owner.pid))!==owner.birth;}
                catch{dead=Date.now()-inode.mtimeMs>30_000;}
                if(dead&&(await stat(file)).ino===inode.ino){await unlink(file);continue;}
            }catch(error:any){if(error.code==="ENOENT")continue;throw error;}
            if(Date.now()>deadline)throw new Error("Another Tango initial sign-in is still finishing");
            await new Promise(resolve=>setTimeout(resolve,250));
        }
    }
    try{return await work();}
    finally{try{if(JSON.parse(await readFile(file,"utf8")).nonce===nonce)await unlink(file);}catch(error:any){if(error.code!=="ENOENT")throw error;}}
}
