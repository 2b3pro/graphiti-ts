# Codebase Audit

```
Conduct a six-axis codebase audit across the repository at [CODEBASE PATH], producing a severity-ranked findings report. Work systematically through each axis below, reading every relevant file before rendering judgment — surface only findings you can substantiate with file paths and line references.

**Axis 1 — Bugs & Logic Defects.** Trace control flow, boundary conditions, null/undefined propagation, off-by-one errors, race conditions, unhandled promise rejections, type coercion hazards, silent failures masked by catch-all handlers, and state mutations that violate invariants. Flag any code path where the observable behavior diverges from the apparent intent.

**Axis 2 — Code Quality & Improvements.** Assess naming precision, function cohesion (single-responsibility adherence), abstraction level consistency within modules, error message informativeness, guard clause placement, cyclomatic complexity hotspots, and any "clever" code that sacrifices readability for brevity. Evaluate whether tests exist for critical paths and whether they test behavior or implementation details.

**Axis 3 — Performance.** Identify N+1 query patterns, unbounded iteration over growing collections, unnecessary re-computation (missing memoization where call frequency warrants it), synchronous blocking in async contexts, over-allocation (large object creation in hot loops), missing pagination or streaming for large datasets, and any O(n²) or worse algorithm where O(n log n) or O(n) alternatives are straightforward. Distinguish between cold-path inefficiencies (note but deprioritize) and hot-path bottlenecks (flag as high severity).

**Axis 4 — Redundancy & DRY Violations.** Locate duplicated logic across files, near-identical functions that differ only in a parameter, copy-pasted validation/transformation chains, repeated type definitions or interface shapes, and utility functions that reinvent standard library capabilities. For each finding, propose the minimal consolidation — a shared helper, a parameterized function, a base class — without over-abstracting. Three similar lines are fine; three similar *blocks* are not.

**Axis 5 — Scalability.** Evaluate data structure choices under 10x and 100x current load assumptions. Flag in-memory collections that should be externalized, missing indexing strategies, fan-out patterns without backpressure, single-threaded bottlenecks in concurrent workloads, hardcoded limits or batch sizes, and any architecture that assumes a single process or single machine. Assess whether the codebase's current patterns degrade gracefully or cliff-edge under load.

**Axis 6 — Extensibility & Architecture.** Map the dependency graph between modules — identify tight coupling (concrete dependencies where interfaces would serve), missing extension points for likely future requirements visible from the domain, god-objects or god-modules that accumulate unrelated responsibilities, and violations of the dependency inversion principle. Evaluate whether adding a new [entity/feature/integration] requires modifying existing code (closed for extension) or can be accomplished through composition and configuration (open for extension).

**Output format — a single structured report:**

For each finding, emit:
- **[SEV: CRITICAL | HIGH | MEDIUM | LOW]** — Severity tag
- **Axis** — Which of the six axes
- **Location** — file:line or file:function
- **Finding** — One-sentence diagnosis
- **Evidence** — The specific code pattern or behavior observed
- **Recommendation** — Concrete fix, not vague advice

Group findings by severity (CRITICAL first), then by axis within each severity band. Close with a **Summary** section: total findings per severity, the three highest-leverage changes that would improve the codebase most, and an overall health assessment (one paragraph).

Calibrate severity: CRITICAL = data loss, security hole, or silent corruption in production. HIGH = incorrect behavior under reachable conditions or performance cliff. MEDIUM = maintainability drag, moderate inefficiency, or coupling that will bite on next feature. LOW = style, minor optimization, or speculative improvement.

**CODEBASE PATH**:
```
