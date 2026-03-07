import { CONSTANTS } from "../../core/constants";

export class ActionService {
    private defaultInit: RequestInit;

    constructor(defaultInit: RequestInit) {
        this.defaultInit = defaultInit;
    }

    public follow(streamerId: string): Promise<Response> {
        return fetch(CONSTANTS.API.FOLLOW_ADD, {
            method: "POST",
            body: streamerId,
            ...this.defaultInit,
        });
    }

    public unfollow(streamerId: string): Promise<Response> {
        return fetch(CONSTANTS.API.FOLLOW_REMOVE, {
            method: "POST",
            body: streamerId,
            ...this.defaultInit,
        });
    }

    public block(streamerId: string): Promise<Response> {
        return fetch(`${CONSTANTS.API.BLOCK_LIST}?accountId=${streamerId}`, {
            method: "POST",
            ...this.defaultInit,
        });
    }
}
