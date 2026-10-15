# 開発

GNOME 版は `src/`、macOS 版は `mac/` にある。表示する文字列、並び順、色分けの判定は `src/model.js` だけが持ち、macOS 版はこのファイルを JavaScriptCore で読み込んで同じ `renderView()` を呼ぶ。表示を変えるときは `src/model.js` を直せば両方に効く。OpenRouter の応答の解釈と、ログインシェルに渡すキー読み出しのスクリプト (`OPENROUTER_KEY_SCRIPT`) もここにある。macOS 版の Swift が受け持つのは omp の実行、設定の保存、メニューバーへの描画だけだ。OpenRouter の取得は GNOME 版の `src/store.js` にしかなく、macOS 版は `renderView()` に OpenRouter の状態を渡さないので欄が出ない。

GNOME 版のコードを変えたら `make install` のあとに再ログインする。Wayland の GNOME Shell は動作中に拡張を読み直さない。

## テストは headless の GNOME Shell で画面まで確かめる

```sh
make test-unit             # gjs だけで動く。表示ロジック (src/model.js) と omp の呼び出し (src/store.js)
make test-shell            # headless の GNOME Shell に拡張を入れ、操作しながら画面を撮る
tests/shell/run.sh real    # 本物の omp で同じ確認をする
```

`make test-shell` は `dbus-run-session -- gnome-shell-test-tool --headless` で別セッションの GNOME Shell を起動するので、ログイン中のデスクトップには触れない。動作確認に使っているのは GNOME Shell 50.5。シナリオは 4 つある。

- `success`: 取得した内容がトップバーとドロップダウンに出る。トップバーに出ない枠の警告が、トップバーとスクロールしなくても見える位置の両方に出る。
- `fail-stale`: 取得に失敗しても前回の値を残す。
- `disable-midfetch`: omp が応答しない間に拡張を無効にすると、子プロセスが止まる。
- `prefs`: 設定画面を開き直しても、シェル側で変えた設定が保たれる。

`tests/shell/run.sh fail-stale prefs` のようにシナリオ名を渡すと、そのシナリオだけを実行する。ログとスクリーンショットは `tests/out/` に出る。

## omp の代わりに fake-omp を使う

`tests/fixtures/fake-omp` は `tests/fixtures/usage.json` の時刻を現在時刻にずらして返し、`omp config get auth.accountPolicies --json` には `tests/fixtures/config.json` を返す。次の環境変数で動きを変えられる。

| 環境変数 | 動き |
|---|---|
| `FAKE_OMP_MODE=fail` | 標準エラーにエラー文を書き、終了コード 1 を返す。標準出力は空。 |
| `FAKE_OMP_MODE=hang` | 応答しなくなる。 |
| `FAKE_OMP_POLICY_MODE=fail` | 設定の読み出しだけが失敗する。 |
| `FAKE_OMP_LOG=<path>` | 受け取った引数を 1 回 1 行で `<path>` に追記する。 |

## OpenRouter はテストで本物を呼ばない

`tests/store-test.js` は、開発者自身の鍵で OpenRouter を呼ばないように、最初に `OPENROUTER_API_KEY` と `OPENROUTER_MANAGEMENT_KEY` を消す。ログインシェルの代わりには、渡されたスクリプトを `FAKE_OPENROUTER_KEY` と `FAKE_OPENROUTER_MANAGEMENT_KEY` を鍵として実行するだけの偽シェルを `SHELL` に入れる。OpenRouter の代わりはローカルの `Soup.Server` で、`/key` と `/activity` に別々の応答を返す。

`tests/shell/run.sh` も、fake-omp を使うシナリオでは `OPENROUTER_API_KEY` と `OPENROUTER_MANAGEMENT_KEY` を消して `SHELL=/bin/false` で動かす。README の画像に自分の消費額が写らないようにするためだ。`real` シナリオだけは手元の環境をそのまま渡すので、本物の OpenRouter の欄が出る。ただし `gnome-shell-test-tool` は `XDG_CONFIG_HOME` を一時ディレクトリに向けるので、拡張がログインシェルに聞く経路では `~/.config` 配下から読む鍵が見つからない。`real` で OpenRouter を出すには、呼び出し側のシェルで両方の鍵を export しておく。

## macOS 版はメニューバーで確かめる

```sh
make mac-test   # XCTest。src/model.js の読み込みと、fake-omp を使った omp の呼び出し
make mac-app    # dist/oh-my-usage.app を作る
open -n dist/oh-my-usage.app --args -ompPath "$PWD/tests/fixtures/fake-omp"
```

設定は UserDefaults に `ompPath`、`refreshInterval`、`panelDisplay`、`primaryAccount` の名前で入る。起動引数に `-ompPath <path>` のように渡すと、保存した値より優先される。fake-omp に向けるときはこれを使う。

Bartender や Barbee のようなメニューバー整理アプリを使っていると、新しい項目が隠れて見えないことがある。その場合は起動引数に `"-NSStatusItem Preferred Position Item-0" 400` を足すと、画面の右端から 400 pt の位置に出る。AppKit はこの位置を `io.github.ymkthr.oh-my-usage` に保存するので、確かめ終えたら `defaults delete io.github.ymkthr.oh-my-usage` で消す。

## macOS 版のリリースは tag を push する

1. `src/metadata.json` の `version-name` を上げてコミットする。
2. `git tag v<version-name>` を作って push する。

`.github/workflows/release-mac.yml` が tag と `version-name` の一致を確かめ、`make mac-test` と `make mac-zip` を実行して、GitHub Release に `oh-my-usage.zip` を載せる。zip の中身は arm64 と x86_64 を含むユニバーサルバイナリで、アドホック署名だけを付けている。[ymkthr/homebrew-tap](https://github.com/ymkthr/homebrew-tap) の日次ジョブが最新のリリースを読み、cask の `version` と `sha256` を書き換える。すぐ反映したいときは、tap の Actions から「Update Casks & Formulas」を手動で実行する。

## D-Bus の起動待ちで落ちたら再実行する

シナリオが `oh-my-usage test:` の行を 1 つも出さずに失敗し、ログに `Failed to activate service 'org.freedesktop.secrets': timed out` があれば、テスト用 D-Bus セッションの起動待ちで時間切れになっている。拡張の不具合ではないので、そのシナリオだけ再実行する。
