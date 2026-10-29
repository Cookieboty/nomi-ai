package usage

import "math"

// jsSortStable：V8 Array.prototype.sort（third_party/v8/builtins/array-sort.tq 的 TimSort）逐步移植。
// 比较函数结果按 SortCompareUserFn 处理：NaN 视为 0。比较函数不一致（如 NaN、字符串拼接后的 token）时，
// 结果顺序依赖算法细节，所以这里不用 sort.SliceStable。
func jsSortStable[T any](a []T, cmp func(x, y T) float64) {
	if len(a) < 2 {
		return
	}
	s := &timSort[T]{a: a, minGallop: 7, cmp: func(x, y T) float64 {
		v := cmp(x, y)
		if math.IsNaN(v) {
			return 0
		}
		return v
	}}
	s.sort()
}

type tsRun struct{ base, len int }

type timSort[T any] struct {
	a         []T
	cmp       func(x, y T) float64
	minGallop int
	runs      []tsRun
}

func computeMinRunLength(n int) int {
	r := 0
	for n >= 64 {
		r |= n & 1
		n >>= 1
	}
	return n + r
}

func (s *timSort[T]) sort() {
	low, remaining := 0, len(s.a)
	minRun := computeMinRunLength(remaining)
	for remaining != 0 {
		cur := s.countAndMakeRun(low, low+remaining)
		if cur < minRun {
			forced := minRun
			if remaining < forced {
				forced = remaining
			}
			s.binaryInsertionSort(low, low+cur, low+forced)
			cur = forced
		}
		s.runs = append(s.runs, tsRun{low, cur})
		s.mergeCollapse()
		low += cur
		remaining -= cur
	}
	s.mergeForceCollapse()
}

func (s *timSort[T]) countAndMakeRun(lowArg, high int) int {
	low := lowArg + 1
	if low == high {
		return 1
	}
	runLength := 2
	elementLow, elementLowPre := s.a[low], s.a[low-1]
	order := s.cmp(elementLow, elementLowPre)
	desc := order < 0
	previous := elementLow
	for idx := low + 1; idx < high; idx++ {
		current := s.a[idx]
		order = s.cmp(current, previous)
		if desc {
			if order >= 0 {
				break
			}
		} else if order < 0 {
			break
		}
		previous = current
		runLength++
	}
	if desc {
		for i, j := lowArg, lowArg+runLength-1; i < j; i, j = i+1, j-1 {
			s.a[i], s.a[j] = s.a[j], s.a[i]
		}
	}
	return runLength
}

func (s *timSort[T]) binaryInsertionSort(low, startArg, high int) {
	start := startArg
	if low == startArg {
		start++
	}
	for ; start < high; start++ {
		left, right := low, start
		pivot := s.a[start]
		for left < right {
			mid := left + ((right - left) >> 1)
			if s.cmp(pivot, s.a[mid]) < 0 {
				right = mid
			} else {
				left = mid + 1
			}
		}
		for p := start; p > left; p-- {
			s.a[p] = s.a[p-1]
		}
		s.a[left] = pivot
	}
}

func (s *timSort[T]) invariant(n int) bool {
	if n < 2 {
		return true
	}
	return s.runs[n-2].len > s.runs[n-1].len+s.runs[n].len
}

func (s *timSort[T]) mergeCollapse() {
	for len(s.runs) > 1 {
		n := len(s.runs) - 2
		if !s.invariant(n+1) || !s.invariant(n) {
			if s.runs[n-1].len < s.runs[n+1].len {
				n--
			}
			s.mergeAt(n)
		} else if s.runs[n].len <= s.runs[n+1].len {
			s.mergeAt(n)
		} else {
			break
		}
	}
}

func (s *timSort[T]) mergeForceCollapse() {
	for len(s.runs) > 1 {
		n := len(s.runs) - 2
		if n > 0 && s.runs[n-1].len < s.runs[n+1].len {
			n--
		}
		s.mergeAt(n)
	}
}

func (s *timSort[T]) mergeAt(i int) {
	baseA, lenA := s.runs[i].base, s.runs[i].len
	baseB, lenB := s.runs[i+1].base, s.runs[i+1].len
	s.runs[i].len = lenA + lenB
	if i == len(s.runs)-3 {
		s.runs[i+1] = s.runs[i+2]
	}
	s.runs = s.runs[:len(s.runs)-1]
	k := s.gallopRight(s.a, s.a[baseB], baseA, lenA, 0)
	baseA += k
	lenA -= k
	if lenA == 0 {
		return
	}
	lenB = s.gallopLeft(s.a, s.a[baseA+lenA-1], baseB, lenB, lenB-1)
	if lenB == 0 {
		return
	}
	if lenA <= lenB {
		s.mergeLow(baseA, lenA, baseB, lenB)
	} else {
		s.mergeHigh(baseA, lenA, baseB, lenB)
	}
}

func (s *timSort[T]) gallopLeft(arr []T, key T, base, length, hint int) int {
	lastOfs, offset := 0, 1
	if s.cmp(arr[base+hint], key) < 0 {
		maxOfs := length - hint
		for offset < maxOfs {
			if s.cmp(arr[base+hint+offset], key) >= 0 {
				break
			}
			lastOfs = offset
			offset = (offset << 1) + 1
			if offset <= 0 {
				offset = maxOfs
			}
		}
		if offset > maxOfs {
			offset = maxOfs
		}
		lastOfs += hint
		offset += hint
	} else {
		maxOfs := hint + 1
		for offset < maxOfs {
			if s.cmp(arr[base+hint-offset], key) < 0 {
				break
			}
			lastOfs = offset
			offset = (offset << 1) + 1
			if offset <= 0 {
				offset = maxOfs
			}
		}
		if offset > maxOfs {
			offset = maxOfs
		}
		tmp := lastOfs
		lastOfs = hint - offset
		offset = hint - tmp
	}
	lastOfs++
	for lastOfs < offset {
		m := lastOfs + ((offset - lastOfs) >> 1)
		if s.cmp(arr[base+m], key) < 0 {
			lastOfs = m + 1
		} else {
			offset = m
		}
	}
	return offset
}

func (s *timSort[T]) gallopRight(arr []T, key T, base, length, hint int) int {
	lastOfs, offset := 0, 1
	if s.cmp(key, arr[base+hint]) < 0 {
		maxOfs := hint + 1
		for offset < maxOfs {
			if s.cmp(key, arr[base+hint-offset]) >= 0 {
				break
			}
			lastOfs = offset
			offset = (offset << 1) + 1
			if offset <= 0 {
				offset = maxOfs
			}
		}
		if offset > maxOfs {
			offset = maxOfs
		}
		tmp := lastOfs
		lastOfs = hint - offset
		offset = hint - tmp
	} else {
		maxOfs := length - hint
		for offset < maxOfs {
			if s.cmp(key, arr[base+hint+offset]) < 0 {
				break
			}
			lastOfs = offset
			offset = (offset << 1) + 1
			if offset <= 0 {
				offset = maxOfs
			}
		}
		if offset > maxOfs {
			offset = maxOfs
		}
		lastOfs += hint
		offset += hint
	}
	lastOfs++
	for lastOfs < offset {
		m := lastOfs + ((offset - lastOfs) >> 1)
		if s.cmp(key, arr[base+m]) < 0 {
			offset = m
		} else {
			lastOfs = m + 1
		}
	}
	return offset
}

const kMinGallopWins = 7

func (s *timSort[T]) mergeLow(baseA, lenA, baseB, lenB int) {
	a := s.a
	temp := append([]T(nil), a[baseA:baseA+lenA]...)
	dest, cursorTemp, cursorB := baseA, 0, baseB
	a[dest] = a[cursorB]
	dest++
	cursorB++
	lenB--
	succeed := func() {
		if lenA > 0 {
			copy(a[dest:dest+lenA], temp[cursorTemp:cursorTemp+lenA])
		}
	}
	copyB := func() {
		copy(a[dest:dest+lenB], a[cursorB:cursorB+lenB])
		a[dest+lenB] = temp[cursorTemp]
	}
	if lenB == 0 {
		succeed()
		return
	}
	if lenA == 1 {
		copyB()
		return
	}
	minGallop := s.minGallop
	for {
		nofWinsA, nofWinsB := 0, 0
		for {
			if s.cmp(a[cursorB], temp[cursorTemp]) < 0 {
				a[dest] = a[cursorB]
				dest++
				cursorB++
				nofWinsB++
				lenB--
				nofWinsA = 0
				if lenB == 0 {
					succeed()
					return
				}
				if nofWinsB >= minGallop {
					break
				}
			} else {
				a[dest] = temp[cursorTemp]
				dest++
				cursorTemp++
				nofWinsA++
				lenA--
				nofWinsB = 0
				if lenA == 1 {
					copyB()
					return
				}
				if nofWinsA >= minGallop {
					break
				}
			}
		}
		minGallop++
		first := true
		for nofWinsA >= kMinGallopWins || nofWinsB >= kMinGallopWins || first {
			first = false
			minGallop--
			if minGallop < 1 {
				minGallop = 1
			}
			s.minGallop = minGallop
			nofWinsA = s.gallopRight(temp, a[cursorB], cursorTemp, lenA, 0)
			if nofWinsA > 0 {
				copy(a[dest:dest+nofWinsA], temp[cursorTemp:cursorTemp+nofWinsA])
				dest += nofWinsA
				cursorTemp += nofWinsA
				lenA -= nofWinsA
				if lenA == 1 {
					copyB()
					return
				}
				if lenA == 0 {
					succeed()
					return
				}
			}
			a[dest] = a[cursorB]
			dest++
			cursorB++
			lenB--
			if lenB == 0 {
				succeed()
				return
			}
			nofWinsB = s.gallopLeft(a, temp[cursorTemp], cursorB, lenB, 0)
			if nofWinsB > 0 {
				copy(a[dest:dest+nofWinsB], a[cursorB:cursorB+nofWinsB])
				dest += nofWinsB
				cursorB += nofWinsB
				lenB -= nofWinsB
				if lenB == 0 {
					succeed()
					return
				}
			}
			a[dest] = temp[cursorTemp]
			dest++
			cursorTemp++
			lenA--
			if lenA == 1 {
				copyB()
				return
			}
		}
		minGallop++
		s.minGallop = minGallop
	}
}

func (s *timSort[T]) mergeHigh(baseA, lenA, baseB, lenB int) {
	a := s.a
	temp := append([]T(nil), a[baseB:baseB+lenB]...)
	dest, cursorTemp, cursorA := baseB+lenB-1, lenB-1, baseA+lenA-1
	a[dest] = a[cursorA]
	dest--
	cursorA--
	lenA--
	succeed := func() {
		if lenB > 0 {
			copy(a[dest-(lenB-1):dest+1], temp[0:lenB])
		}
	}
	copyA := func() {
		dest -= lenA
		cursorA -= lenA
		copy(a[dest+1:dest+1+lenA], a[cursorA+1:cursorA+1+lenA])
		a[dest] = temp[cursorTemp]
	}
	if lenA == 0 {
		succeed()
		return
	}
	if lenB == 1 {
		copyA()
		return
	}
	minGallop := s.minGallop
	for {
		nofWinsA, nofWinsB := 0, 0
		for {
			if s.cmp(temp[cursorTemp], a[cursorA]) < 0 {
				a[dest] = a[cursorA]
				dest--
				cursorA--
				nofWinsA++
				lenA--
				nofWinsB = 0
				if lenA == 0 {
					succeed()
					return
				}
				if nofWinsA >= minGallop {
					break
				}
			} else {
				a[dest] = temp[cursorTemp]
				dest--
				cursorTemp--
				nofWinsB++
				lenB--
				nofWinsA = 0
				if lenB == 1 {
					copyA()
					return
				}
				if nofWinsB >= minGallop {
					break
				}
			}
		}
		minGallop++
		first := true
		for nofWinsA >= kMinGallopWins || nofWinsB >= kMinGallopWins || first {
			first = false
			minGallop--
			if minGallop < 1 {
				minGallop = 1
			}
			s.minGallop = minGallop
			k := s.gallopRight(a, temp[cursorTemp], baseA, lenA, lenA-1)
			nofWinsA = lenA - k
			if nofWinsA > 0 {
				dest -= nofWinsA
				cursorA -= nofWinsA
				copy(a[dest+1:dest+1+nofWinsA], a[cursorA+1:cursorA+1+nofWinsA])
				lenA -= nofWinsA
				if lenA == 0 {
					succeed()
					return
				}
			}
			a[dest] = temp[cursorTemp]
			dest--
			cursorTemp--
			lenB--
			if lenB == 1 {
				copyA()
				return
			}
			k = s.gallopLeft(temp, a[cursorA], 0, lenB, lenB-1)
			nofWinsB = lenB - k
			if nofWinsB > 0 {
				dest -= nofWinsB
				cursorTemp -= nofWinsB
				copy(a[dest+1:dest+1+nofWinsB], temp[cursorTemp+1:cursorTemp+1+nofWinsB])
				lenB -= nofWinsB
				if lenB == 1 {
					copyA()
					return
				}
				if lenB == 0 {
					succeed()
					return
				}
			}
			a[dest] = a[cursorA]
			dest--
			cursorA--
			lenA--
			if lenA == 0 {
				succeed()
				return
			}
		}
		minGallop++
		s.minGallop = minGallop
	}
}
