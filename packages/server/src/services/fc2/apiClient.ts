const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Whether FC2 has a channel with this ID. FC2 answers every number, with an empty profile for
// a channel that does not exist. Throws when FC2 cannot answer, so a failed lookup never reads
// as "no such channel".
export async function fc2ChannelExists(channelId: string): Promise<boolean> {
    if (!/^\d+$/.test(channelId)) return false;
    const response = await fetch("https://live.fc2.com/api/memberApi.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, Referer: "https://live.fc2.com/" },
        body: new URLSearchParams({ channel: "1", profile: "1", user: "0", streamid: channelId }),
    });
    if (!response.ok) throw new Error(`FC2 lookup failed: ${response.status}`);
    const body = await response.json() as { data?: { profile_data?: { userid?: string } } } | null;
    if (!body?.data) throw new Error("FC2 lookup gave no answer");
    return Boolean(body.data.profile_data?.userid);
}
