OpenTune {{APP_VERSION}}（含本机控制接口）
非官方测试版 {{BUILD_LABEL}}，macOS（Apple 芯片，arm64）

(English: README-UNOFFICIAL.txt)

这不是 OpenTune 官方版本
========================

- OpenTune 是 DAYA STUDIO 的项目（作者 风语，GitHub YuFeng926），采用 GNU AGPL v3
  许可。官方仓库是 {{OFFICIAL_REPO_URL}}。
  它的 Releases 页面 {{OFFICIAL_RELEASES_URL}}
  是 OpenTune 唯一的官方发布渠道。
- 本测试版由 Synchain 从 fork {{FORK_REPO_URL}} 构建，
  是在 OpenTune 上加入本机控制接口的版本，供 OpenTune MCP Server (by Synchain)
  操作 OpenTune 使用。它不是 DAYA STUDIO 制作、审核或认可的版本。
- 免费提供。不含任何模型权重：AI 模型来自你自己安装的官方 OpenTune（见 INSTALL.zh-CN.txt）。
- 这是测试软件，可能有问题，请备份你的工程。
- 只支持 Apple 芯片的 Mac（arm64），不支持 Intel Mac。
- 本测试版的问题请到 {{ISSUES_URL}} 反馈。
  请不要反馈给 OpenTune 官方项目；在官方版本里也能复现的问题，才属于官方项目。

本机控制接口
============

- 默认关闭。只有用 OpenTune-AI.command 启动（它会传命令行参数 --control-api），
  或设置环境变量 OPENTUNE_CONTROL_API=1 时才开启。
- 只监听 127.0.0.1（本机），端口由 macOS 分配。开启期间，以你的 macOS 账户
  运行的任何程序都能找到它并操作 OpenTune。不要在多人共用的账户里开启。
- 直接打开 OpenTune-ctl.app 时接口关闭，行为与官方 OpenTune {{APP_VERSION}} 相同
  （MODIFICATIONS.md 列出的差异除外）。

未经 Apple 签名认证
===================

应用使用临时签名（ad hoc），没有经过公证（OpenTune 官方的 macOS 版同样没有公证），也没有
Apple 开发者 ID。所以 macOS 的 Gatekeeper 会拦截第一次启动，INSTALL.zh-CN.txt 介绍了两种
放行办法。这个签名仍然能发现文件损坏，INSTALL.zh-CN.txt 也写了如何校验。

本文件夹中的文件
================

  OpenTune-ctl.app                程序本体；名字与官方的 OpenTune.app 不同，
                                  不会覆盖官方版（Bundle 标识 ca.synchain.opentune.ctltest）
    Contents/MacOS/OpenTune       可执行文件
    Contents/MacOS/opentune-control.json
                                  构建信息，供 OpenTune MCP Server 读取
    Contents/Frameworks/{{ORT_DYLIB}}
                                  ONNX Runtime（macOS arm64）
  OpenTune-AI.command             以开启控制接口的方式启动 OpenTune-ctl.app
  LICENSE.txt                     GNU AGPL v3（OpenTune 的许可）
  THIRD-PARTY-NOTICES.txt         第三方组件及其许可
  README-UNOFFICIAL.zh-CN.txt     本文件（README-UNOFFICIAL.txt 为英文版）
  INSTALL.zh-CN.txt               安装步骤（INSTALL.txt 为英文版）
  MODIFICATIONS.md                本测试版相对 OpenTune 的改动
  SHA256SUMS                      其余每个文件的 SHA-256

源代码
======

本测试版：{{SOURCE_URL}}
（tag {{TAG}}，提交 {{COMMIT}}）。
该目录树就是本测试版在 AGPL 下的完整对应源代码，包括构建脚本（.github/）与依赖锁定
文件（.github/scripts/deps.lock.json）。精确的构建命令列在本测试版的发布页面上。
