// Every eBay request in the server goes through an injected fetchFn, so a call to the global fetch
// in a test is a mistake that would reach the network. It fails the test instead.
globalThis.fetch = function fetch(): never {
  throw new Error("global fetch called in a server test; pass an injected fetchFn instead");
};
