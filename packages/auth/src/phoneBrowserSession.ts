import {readFile} from "node:fs/promises";
import {getConfig} from "./common/config.js";
import {browserOwner} from "./providers/tango/tangoBrowserOwner.js";
import type {Account} from "./providers/interfaces.js";

// The phone's profile is separate from every PC recording account. This owner
// alone consumes its RT; callers receive the current session without a new login.
export async function phoneBrowserSession(requestId:string):Promise<{cookies:unknown[]}> {
    const configured=JSON.parse(await readFile(getConfig().accountsPath,"utf8")).accounts as Account[];
    const account=configured.find(a=>(a.provider??"tango")==="tango");
    if(!account)throw new Error("No Tango account is configured");
    const owner=browserOwner("phone");
    return owner.provision(account,requestId);
}
export async function acknowledgePhoneSetup(requestId:string):Promise<void>{await browserOwner("phone").acknowledgeProvision(requestId);}
