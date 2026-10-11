# Pending load-contract fixtures

Each scenario module exports the same **local test wrapper**: a descriptive
`scenarioLabel` and `readContractExamples()`. Neither is a wire field.
Reading contract examples throws until Claude freezes the 10.1 contract.
There are no guessed requests, responses, revision fields, RPC names or errors.

Fill the function with verbatim, versioned examples from that contract later;
keep the scenario files and wrapper. Record the contract version and source
commit with those examples. The wrapper must then expose the contract's own
request/result/error examples, without translating or renaming their fields.

The seven roadmap scenarios have separate files. Permission, shortage and
lost-response each have another file so that failure behaviour cannot be
hidden inside a successful-day example. Tests currently prove these are
unusable placeholders, not valid load fixtures or backend verification.
