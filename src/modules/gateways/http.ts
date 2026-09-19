/** One injectable `fetch` for every gateway, so tests never touch the network. */
let http: typeof fetch = (...args) => fetch(...args);
export const gatewayHttp: typeof fetch = (...args) => http(...args);
export const setGatewayHttpForTests = (fake: typeof fetch) => void (http = fake);
