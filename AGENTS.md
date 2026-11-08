# AGENTS.md

- **Clean Code**: clear names, small functions, errors handled explicitly. No flag parameters: a boolean that picks
  between two behaviors makes two functions; a boolean that is a value — a mode being set, an option's field — is data.
- **KISS**: the simplest design that works.
- **YAGNI**: build nothing before it is needed; no compatibility shims, change the API and migrate the callers.
- **Design, not patches**: design from the architecture, not from the symptom — find the concept that should hold a
  need and change the design until the need is a plain case of it; never bolt on a special case, a flag, an override
  layer or a fallback. One concept, one place: where two mechanisms do nearly the same job, make them one.
- **Memory, in Zig**: free what is allocated once it is done with — `defer` or `errdefer` beside the allocation, an
  arena for what lives and dies together — so nothing leaks, on an error path either. Let the toolchain check it: tests
  allocate through `std.testing.allocator`, which fails a test that leaks or frees twice; a function that takes several
  things in turn — a constructor, a decoder, a builder — is tested with `std.testing.checkAllAllocationFailures`, so a
  failure at any step frees what came before; a program's debug build runs on `std.heap.SafeAllocator`, checked as it
  exits; release builds stay `ReleaseSafe`.
- **Code style**: read like the code around it.
- **This file** changes only with the user's confirmation.
