// CI runners (macOS in particular) can be an order of magnitude slower than a dev machine for
// happy-dom rendering; the default 1s findBy*/waitFor timeout then flakes. Only affects how
// long we are willing to wait for an element that does appear — failures still fail.
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5000 });
