import { CONSTANTS } from "../../core/constants";
import { xhrFetch, XhrResponse } from "../../core/xhr-fetch";

export class ActionService {
    public follow(streamerId: string): Promise<XhrResponse> {
        return xhrFetch(CONSTANTS.API.FOLLOW_ADD, {
            method: "POST",
            body: streamerId,
        });
    }

    public unfollow(streamerId: string): Promise<XhrResponse> {
        return xhrFetch(CONSTANTS.API.FOLLOW_REMOVE, {
            method: "POST",
            body: streamerId,
        });
    }

    public block(streamerId: string): Promise<XhrResponse> {
        return xhrFetch(`${CONSTANTS.API.BLOCK_LIST}?accountId=${streamerId}`, {
            method: "POST",
        });
    }
}
