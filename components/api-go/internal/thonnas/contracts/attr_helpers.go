package contracts

// StringMapToThonnasAttributes copies map[string]string dimensions into ThonnasAttributes.
//
// @intent Bridge legacy label maps to portable metric attributes without importing OTLP types
func StringMapToThonnasAttributes(m map[string]string) ThonnasAttributes {
	if len(m) == 0 {
		return nil
	}
	out := make(ThonnasAttributes, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

