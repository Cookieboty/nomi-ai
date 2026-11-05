package gwstore

import "fmt"

// ModelsDataHooks wires the UsageService's models.dev sync to the gateway:
//
//	onModelsData: (api) => services.gateway?.applyModelsData(api),
//	needsFullModelsData: () => { const g = services.gateway; return g ? !g.hasCatalogSync() : false; },
//
// The results plug straight into usage.PriceSyncDeps{OnData, NeedsFull}. A nil
// Service behaves like an absent gateway (onData is a no-op, needsFull is false).
// The background disk write is not awaited; a synchronous failure
// (panic) is returned as an error so PriceSync logs "models data consumer failed".
func (s *Service) ModelsDataHooks() (onData func(api any) error, needsFull func() bool) {
	return s.modelsDataHooks(nil)
}

// modelsDataHooks: written receives each background-write channel (tests wait on it).
func (s *Service) modelsDataHooks(written func(<-chan struct{})) (onData func(api any) error, needsFull func() bool) {
	onData = func(api any) (err error) {
		if s == nil {
			return nil
		}
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("%v", r)
			}
		}()
		done := s.ApplyModelsData(api)
		if written != nil {
			written(done)
		}
		return nil
	}
	needsFull = func() bool {
		if s == nil {
			return false
		}
		return !s.HasCatalogSync()
	}
	return onData, needsFull
}
