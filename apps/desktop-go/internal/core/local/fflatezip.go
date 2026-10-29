package local

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"hash/crc32"
	"time"
	"unicode/utf8"
)

type zipEntry struct {
	name string
	data []byte
}

// fflateZipSync 按 fflate zipSync 的头部布局写 zip：条目按插入顺序；
// version made by = 20 / os = 0，version needed = 20，无 data descriptor、无 extra、
// external attrs = 0，DOS 时间按本地时区（fflate 用 Date 本地字段），
// 文件名非 ASCII 时置 UTF-8 位（0x800）。deflate 级别 6（fflate 默认）。
// 唯一差异：压缩流字节来自 compress/flate 而非 fflate 的编码器（解压后内容相同）。
func fflateZipSync(entries []zipEntry, now func() time.Time) ([]byte, error) {
	type rec struct {
		f, c      []byte
		crc, size uint32
		off       uint32
		utf       bool
		dos       uint32
	}
	var body bytes.Buffer
	recs := make([]rec, 0, len(entries))
	for _, e := range entries {
		var cb bytes.Buffer
		fw, _ := flate.NewWriter(&cb, 6)
		if _, err := fw.Write(e.data); err != nil {
			return nil, err
		}
		if err := fw.Close(); err != nil {
			return nil, err
		}
		r := rec{f: []byte(e.name), c: cb.Bytes(), crc: crc32.ChecksumIEEE(e.data), size: uint32(len(e.data)),
			off: uint32(body.Len()), utf: utf8.RuneCountInString(e.name) != len(e.name), dos: dosTime(now())}
		writeZipHeader(&body, r.f, r.c, r.crc, r.size, r.utf, r.dos, -1)
		body.Write(r.c)
		recs = append(recs, r)
	}
	cdStart := body.Len()
	for _, r := range recs {
		writeZipHeader(&body, r.f, r.c, r.crc, r.size, r.utf, r.dos, int64(r.off))
	}
	cdLen := body.Len() - cdStart
	var end [22]byte
	binary.LittleEndian.PutUint32(end[0:], 0x06054b50)
	binary.LittleEndian.PutUint16(end[8:], uint16(len(recs)))
	binary.LittleEndian.PutUint16(end[10:], uint16(len(recs)))
	binary.LittleEndian.PutUint32(end[12:], uint32(cdLen))
	binary.LittleEndian.PutUint32(end[16:], uint32(cdStart))
	body.Write(end[:])
	return body.Bytes(), nil
}

func dosTime(t time.Time) uint32 {
	t = t.In(time.Local)
	return uint32(t.Year()-1980)<<25 | uint32(t.Month())<<21 | uint32(t.Day())<<16 |
		uint32(t.Hour())<<11 | uint32(t.Minute())<<5 | uint32(t.Second())>>1
}

// writeZipHeader 对应 fflate wzh；central < 0 写本地头，否则写中央目录项。
func writeZipHeader(b *bytes.Buffer, fn, c []byte, crc, size uint32, utf bool, dos uint32, central int64) {
	le := binary.LittleEndian
	u16 := func(v uint16) { var x [2]byte; le.PutUint16(x[:], v); b.Write(x[:]) }
	u32 := func(v uint32) { var x [4]byte; le.PutUint32(x[:], v); b.Write(x[:]) }
	if central >= 0 {
		u32(0x02014b50)
		u16(20) // made by 20, os 0
	} else {
		u32(0x04034b50)
	}
	u16(20)
	var fl uint16
	if utf {
		fl = 0x800
	}
	u16(fl)
	u16(8)
	u32(dos)
	u32(crc)
	u32(uint32(len(c)))
	u32(size)
	u16(uint16(len(fn)))
	u16(0)
	if central >= 0 {
		u16(0) // comment
		u16(0) // disk
		u16(0) // internal attrs
		u32(0) // external attrs
		u32(uint32(central))
	}
	b.Write(fn)
}
