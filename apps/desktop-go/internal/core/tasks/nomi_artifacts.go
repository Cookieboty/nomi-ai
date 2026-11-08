package tasks

// nomi_artifacts.go：后台 Nomi 一轮里产出的东西（生成的图片、写过的文件）记成结果的 Artifact，
// 委派结果回到来源对话时一并带回：用户看得到，来源对话里的 Nomi 下一轮也读得到。

import (
	"encoding/json"
	"regexp"
)

// 生图工具结果里素材库的地址（与视图 toolTrace 的 GENERATED_IMAGE_URL 一致）
var generatedImageURL = regexp.MustCompile(`chat-asset://images/[A-Za-z0-9._-]+`)

// 写文件的工具：结果 data 里哪个字段是写到的文件（带 undoId 才是真的写了，dryRun 预览不算）
var nomiWriteTools = map[string]string{
	"fs_write_text": "path",
	"fs_edit":       "path",
	"fs_copy":       "to",
	"fs_move":       "to",
}

// ArtifactImage：生成的图片（Ref 是 chat-asset:// 地址）；ArtifactFile：改动的文件（Ref 是路径）
const (
	ArtifactImage = "image"
	ArtifactFile  = "file"
)

// nomiArtifacts：一次成功的工具调用产出的东西
func nomiArtifacts(tool, output string) []Artifact {
	if tool == "image_generate" {
		out := []Artifact{}
		for _, u := range generatedImageURL.FindAllString(output, -1) {
			out = append(out, Artifact{Kind: ArtifactImage, Ref: u})
		}
		return out
	}
	field, ok := nomiWriteTools[tool]
	if !ok {
		return nil
	}
	var r struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if json.Unmarshal([]byte(output), &r) != nil || !r.OK || r.Data == nil {
		return nil
	}
	if _, wrote := r.Data["undoId"]; !wrote {
		return nil
	}
	if p, _ := r.Data[field].(string); p != "" {
		return []Artifact{{Kind: ArtifactFile, Ref: p}}
	}
	return nil
}

// addArtifacts：按 Kind + Ref 去重，保持先后顺序
func addArtifacts(list []Artifact, more []Artifact) []Artifact {
	for _, a := range more {
		dup := false
		for _, b := range list {
			if a == b {
				dup = true
				break
			}
		}
		if !dup {
			list = append(list, a)
		}
	}
	return list
}
