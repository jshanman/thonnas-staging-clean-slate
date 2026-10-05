# api-go: Task Review Checklist

**Fires when `api-go` is in `components_affected`.**

## Module Ownership (CRITICAL)

Place new code/concepts **only** in the module that owns them. Prefer the matching installed or planned-for-install `tm-*` module. Do **not** alter unrelated modules (e.g. no online-user-count UI in `tm-user` / auth). If none owns it, create a **project-level (non-`tm-*`) module** and declare ownership + in/out-of-scope for future work.

- [ ] Code/concepts in the owning module (or new project-level module with declared scope)
- [ ] Unrelated modules untouched
- [ ] New modules document ownership / responsibilities

**CRITICAL if:** wrong-module placement; new module missing ownership declaration.

---

