import * as fs from "fs";

// An account the daemon keeps signed in, from the accounts file (outside the repository:
// it holds passwords). `provider` names the site (its ID in the sites file); an account
// without one belongs to the first site with auth.
export interface Account {
    email: string;
    password: string;
    provider: string;
}

interface Credentials {
    accounts: (Omit<Account, "provider"> & { provider?: string })[];
}

export function loadAccounts(accountsPath: string, defaultSite: string | undefined): Account[] {
    const fileContent = fs.readFileSync(accountsPath, "utf-8");
    const credentials: Credentials = JSON.parse(fileContent);

    if (!credentials.accounts || !Array.isArray(credentials.accounts)) {
        throw new Error(`${accountsPath} is missing the 'accounts' array.`);
    }

    return credentials.accounts.map((a) => ({
        email: a.email,
        password: a.password,
        provider: a.provider ?? defaultSite ?? "",
    }));
}
