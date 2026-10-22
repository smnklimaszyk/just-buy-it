// eBay, Claude and SMTP go through an injected fetchFn or transport, so a call to the global fetch
// in a worker test is a mistake that would reach the network. It fails the test instead.
globalThis.fetch = function fetch(): never {
  throw new Error("global fetch called in a worker test; pass an injected fetchFn instead");
};
