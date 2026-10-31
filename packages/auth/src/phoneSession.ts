import "dotenv/config";
import {readFileSync} from "node:fs";
import {request} from "node:https";
import {randomUUID} from "node:crypto";
import os from "node:os";
import path from "node:path";

// Operator adapter for the existing authenticated owner. It never opens a
// second browser, reads the PC recording RT or consumes the phone profile's RT.
const home=os.homedir();
const key=readFileSync(path.join(home,".local/share/video-services/tango-phone-key"),"utf8").trim();
const ca=readFileSync(path.join(home,".local/share/mkcert/rootCA.pem"));
const call=request("https://localhost:9999/api/tango/phone-session",{method:"POST",ca,
    headers:{"X-Phone-Key":key,"X-Phone-Request-ID":randomUUID(),"Content-Type":"application/json"},timeout:220_000},response=>{
    let body="";
    response.on("data",chunk=>{body+=chunk;if(body.length>1_000_000)call.destroy(new Error("Unexpected Tango handoff size"));});
    response.on("end",()=>{
        const value=JSON.parse(body);
        if(response.statusCode!==200){process.stderr.write((value.error??"The Tango owner is unavailable")+"\n");process.exitCode=1;return;}
        process.stdout.write("PHONE-SESSION "+JSON.stringify(value)+"\n");
    });
});
call.on("timeout",()=>call.destroy(new Error("The Tango owner did not finish in time")));
call.on("error",error=>{process.stderr.write(error.message+"\n");process.exitCode=1;});
call.end('{"setup":true}');
