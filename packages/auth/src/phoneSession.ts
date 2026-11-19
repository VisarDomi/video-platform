import "dotenv/config";
import {readFileSync} from "node:fs";
import {request} from "node:https";
import {randomUUID} from "node:crypto";
import os from "node:os";
import path from "node:path";
import { closeSites, loadSiteRegistry, servicesHome } from "shared";
import logger from "./common/logger.js";

// Operator adapter for the existing authenticated owner: the server's one-time phone setup
// route (/api/<site>/phone-session). It never opens a second browser, reads the PC
// recording RT or consumes the phone profile's RT.
//   node dist/phoneSession.js [site]   (default: the first site whose auth provisions phones)
const sites = await loadSiteRegistry({ logger });
await closeSites(sites);
const site = process.argv[2]
    ? sites.find(candidate => candidate.id === process.argv[2])
    : sites.find(candidate => candidate.instance.auth?.provisionDevice);
if (!site?.instance.auth?.provisionDevice) {
    process.stderr.write(`No site ${process.argv[2] ?? ""} provisions phone sessions\n`);
    process.exit(1);
}
const label = site.label;

const home=os.homedir();
const key=readFileSync(path.join(servicesHome(),`${site.id}-phone-key`),"utf8").trim();
const ca=readFileSync(path.join(home,".local/share/mkcert/rootCA.pem"));
const call=request(`https://localhost:9999/api/${site.id}/phone-session`,{method:"POST",ca,
    headers:{"X-Phone-Key":key,"X-Phone-Request-ID":randomUUID(),"Content-Type":"application/json"},timeout:220_000},response=>{
    let body="";
    response.on("data",chunk=>{body+=chunk;if(body.length>1_000_000)call.destroy(new Error(`Unexpected ${label} handoff size`));});
    response.on("end",()=>{
        const value=JSON.parse(body);
        if(response.statusCode!==200){process.stderr.write((value.error??`The ${label} owner is unavailable`)+"\n");process.exitCode=1;return;}
        process.stdout.write("PHONE-SESSION "+JSON.stringify(value)+"\n");
    });
});
call.on("timeout",()=>call.destroy(new Error(`The ${label} owner did not finish in time`)));
call.on("error",error=>{process.stderr.write(error.message+"\n");process.exitCode=1;});
call.end('{"setup":true}');
