import { repeatedLiterals } from "@opencanon/validators";

export default [
  repeatedLiterals({
    id: "fact-backed-dry",
    title: "Fact-backed DRY",
    topics: ["dry", "code-quality"],
    why: "Agents need precise DRY signals from structured facts instead of ad hoc source scanning.",
    rule: "Repeated domain literals are checked from extracted facts before new copies are added.",
    in: ["src/**/*.ts"],
    minOccurrences: 3,
    message: "Repeated domain literal should be named.",
    render: { kind: "generated", docs: "docs/opencanon/canon/dry.md", style: "reference" },
    severity: "warning",
  }),
];
