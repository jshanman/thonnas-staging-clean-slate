# api-go: Architecture Draft Guidance

## Module Ownership (CRITICAL)

Place new code/concepts **only** in the module that owns them. Prefer matching installed/planned `tm-*`. Do **not** dump custom needs into unrelated modules (e.g. online-user-count ∉ `tm-user`). If none owns it, plan a **project-level (non-`tm-*`) module** with ownership + in/out-of-scope declared.

- [ ] Owning module identified (or new project-level module with declared scope)
- [ ] Unrelated modules not used as dump sites

---

Keep Go shell (main/wiring/config) separate from business modules; document realtime/concurrency only when required.

