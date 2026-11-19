//go:build !darwin && !linux && !windows

package sideterminal

func startPTY(_ StartOptions) (PTY, error) {
	return nil, ErrUnsupported
}
