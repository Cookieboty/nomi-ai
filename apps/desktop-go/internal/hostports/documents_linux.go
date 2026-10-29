package hostports

import "os"

func documentsDir() string { return linuxDocuments(os.Getenv, os.ReadFile, chromiumHome) }
