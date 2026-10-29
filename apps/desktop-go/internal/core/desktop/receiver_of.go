package desktop

// ReceiverOf = DesktopService.receiverOf：工具调用自带的 provider → 接收者信息
// （名字 / baseURL 缺省从运行时注册表补；本地与否按 baseURL 判断）。baseURL "" = undefined。
func ReceiverOf(id, baseURL string, lookup func(id string) *RuntimeProvider) *Provider {
	var known *RuntimeProvider
	if lookup != nil {
		known = lookup(id)
	}
	name := id
	if known != nil && known.Name != "" { // RuntimeProvider.Name "" = undefined
		name = known.Name
	}
	b := baseURL
	if b == "" && known != nil {
		b = known.BaseURL
	}
	return &Provider{ID: id, Name: name, Local: IsLocalBaseURL(b)}
}

// ReceiverOf 方法形式
func (s *Service) ReceiverOf(id, baseURL string) *Provider {
	var lookup func(string) *RuntimeProvider
	if s.runtime != nil {
		lookup = s.runtime.LookupProvider
	}
	return ReceiverOf(id, baseURL, lookup)
}
