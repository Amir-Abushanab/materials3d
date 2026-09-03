# @materials3d/element

## 0.1.0

### Minor Changes

- Initial release: the `<materials-3d>` custom element, self-registering on import (a no-op
  outside a browser). Attributes: `preset`, `src`, `config`, `poster`, `poster-fit`, `paused`,
  `lazy`, `webgl`, `min-size`, `renderer`, `transparent`; a `config` property for framework
  bindings and a read-only `handle`. Events `materials3d-ready` and `materials3d-fallback`.
