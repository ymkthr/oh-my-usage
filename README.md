# gnome-omp-usage

[omp](https://github.com/can1357/oh-my-pi) の `omp usage` が返す LLM プロバイダーの利用上限を、GNOME のトップバーに出す GNOME Shell 拡張。macOS の CodexBar に近い見た目で、omp に登録した全アカウントの使用率とリセットまでの残り時間を一覧できる。

![トップバーとドロップダウン](docs/menu.png)

## トップバーは主アカウントの一番厳しい枠を出す

トップバーには主アカウントの 5 時間枠と 7 日枠を、2 本の小さなバーと `5h 5% · 7d 12%` の文字で出す。Claude の 7 日枠と 7 日枠 (Fable) のように同じ長さの枠が複数あるときは、使用率の高いほうを出す。主アカウントは既定で一覧の先頭のアカウントで、ドロップダウンでアカウント名をクリックすると切り替わる。

ドロップダウンにはアカウントごとに、枠ごとの使用率バーと「使用率 · リセットまでの残り」を並べる。`✦ 1 reset` はそのアカウントに残っている上限リセット権の数。バーは使用率 80% 以上でオレンジ、90% 以上で赤になる。omp の JSON にも `status` はあるが、警告に変わる使用率がプロバイダーごとに違う(0.8 と 0.9)ので、色は `usedFraction` から拡張側で決めている。

取得に失敗しても前回の値は消さない。ドロップダウンの見出しが赤い `update failed · last 12 min ago` に変わり、トップバーの文字が薄くなる。一度も取得できていないときはトップバーに `!` を出し、ドロップダウンに理由を出す。理由は「omp が見つからない」か、終了コードと stderr の先頭行のどちらか。

## トップバーに出ない枠も 80% 以上なら知らせる

トップバーの数字は主アカウントの 5 時間枠と 7 日枠だけなので、OpenCode Go の月間枠や別アカウントの 7 日枠が減っても、そのままでは気づけない。そこで、トップバーに出していない枠のどれかが使用率 80% 以上になると、トップバーの右端に `⚠ Go 1mo 93% +1` のような表示が増える。中身は一番使っている枠で、`+1` はほかにも 80% 以上の枠が 1 つあるという意味。色は 80% 以上でオレンジ、90% 以上で赤になる。この表示は `panel-display` で文字を消していても出る。

ドロップダウンでは、同じ枠を見出しのすぐ下に `OpenCode Go · Monthly  93% · 6d5h` の形で並べる。アカウント一覧はスクロールするが、この行はスクロール領域の外にあるので、画面の小さい環境でも隠れない。

## 必要なもの

- GNOME Shell 50。動作確認は headless の GNOME Shell 50.5 で行っている。
- `omp usage --json` がこのマシンで動くこと。auth broker 経由の構成でもよい。

## インストールして再ログインする

```sh
ghq get ymkthr/gnome-omp-usage
cd "$(ghq root)/github.com/ymkthr/gnome-omp-usage"
make install
```

`make install` は `dist/` に拡張の zip を作り、`gnome-extensions install --force` で `~/.local/share/gnome-shell/extensions/` に入れる。Wayland の GNOME Shell は動作中に増えた拡張を読み込まないので、一度ログアウトしてログインし直してから有効にする。

```sh
gnome-extensions enable omp-usage@ymkthr.github.io
```

コードを変えたときも、`make install` のあとに再ログインが要る。

## 設定は 4 項目

メニュー下部の **Settings…** か `gnome-extensions prefs omp-usage@ymkthr.github.io` で開く。

| キー | 既定値 | 内容 |
|---|---|---|
| `omp-path` | 空(`~/.bun/bin/omp` を使う) | omp の実行ファイルの絶対パス。GNOME Shell の `PATH` には `~/.bun/bin` が入っていないので、コマンド名では見つからない。 |
| `refresh-interval` | 300 | 定期取得の間隔(秒、30〜3600)。メニューを開いたときにも取得する。 |
| `panel-display` | `bars-and-text` | トップバーにバーと文字の両方を出すか、バーだけか、文字だけか。 |
| `primary-account` | 空(先頭のアカウント) | トップバーに出すアカウント。ドロップダウンでアカウント名をクリックして選ぶ。設定画面では確認と解除だけができる。 |

## キャッシュを捨てるのは Refresh now だけ

定期取得とメニューを開いたときの取得は `omp usage --json` を実行するだけで、omp 側のキャッシュをそのまま使う。auth broker は資格情報ごとに約 5 分キャッシュするので、取得間隔を短くしても上流 API への問い合わせは増えない。

メニューの **Refresh now (invalidate cache)** は `omp usage invalidate` を実行してから読み直す。auth broker を使う構成では、このキャッシュ破棄は broker を共有する他のマシンにも効く。

## テストは headless の GNOME Shell で画面まで確かめる

```sh
make test-unit             # gjs だけで動く。表示ロジック (src/model.js) と omp の呼び出し (src/store.js)
make test-shell            # headless の GNOME Shell に拡張を入れ、操作しながら画面を撮る
tests/shell/run.sh real    # 本物の omp で同じ確認をする
```

`make test-shell` は `dbus-run-session -- gnome-shell-test-tool --headless` で別セッションの GNOME Shell を起動するので、ログイン中のデスクトップには触れない。シナリオは 4 つある。

- `success`: 取得した内容がトップバーとドロップダウンに出る。トップバーに出ない枠の警告が、トップバーとスクロールしなくても見える位置の両方に出る。
- `fail-stale`: 取得に失敗しても前回の値を残す。
- `disable-midfetch`: omp が応答しない間に拡張を無効にすると、子プロセスが止まる。
- `prefs`: 設定画面を開き直しても、シェル側で変えた設定が保たれる。

ログとスクリーンショットは `tests/out/` に出る。

omp の代わりには `tests/fixtures/fake-omp` を使う。`tests/fixtures/usage.json` の時刻を現在時刻にずらして返す。`FAKE_OMP_MODE=fail` で終了コード 1 と空の標準出力を返し、`hang` で応答しなくなる。

シナリオが `omp-usage test:` の行を 1 つも出さずに失敗し、ログに `Failed to activate service 'org.freedesktop.secrets': timed out` があれば、テスト用 D-Bus セッションの起動待ちで時間切れになっている。拡張の不具合ではないので、そのシナリオだけ再実行する。

## ライセンス

MIT
