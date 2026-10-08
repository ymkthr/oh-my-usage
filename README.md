# oh-my-usage

[omp](https://github.com/can1357/oh-my-pi) に登録した LLM アカウントの利用上限を、GNOME のトップバーに出す GNOME Shell 拡張。`omp usage --json` を定期的に実行し、全アカウントの使用率とリセットまでの残り時間を一覧する。

![トップバーとドロップダウン](docs/menu.png)

## 必要なもの

- GNOME Shell 50
- `omp usage --json` が動くこと。auth broker 経由の構成でもよい。

## インストール

```sh
git clone https://github.com/ymkthr/oh-my-usage
cd oh-my-usage
make install
```

`make install` は `dist/` に拡張の zip を作り、`gnome-extensions install --force` で `~/.local/share/gnome-shell/extensions/` に入れる。Wayland の GNOME Shell は動作中に入った拡張を読み込まないので、ログアウトしてログインし直してから有効にする。

```sh
gnome-extensions enable oh-my-usage@ymkthr.github.io
```

更新するときも、`git pull` と `make install` のあとに再ログインが要る。外すときは `make uninstall` を実行する。

## ライセンス

MIT
