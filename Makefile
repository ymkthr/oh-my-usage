UUID := oh-my-usage@ymkthr.github.io
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip

.PHONY: test test-unit test-shell screenshot pack install uninstall clean mac-test mac-app mac-zip mac-install

test: test-unit test-shell

test-unit:
	gjs -m tests/model-test.js
	gjs -m tests/store-test.js
	glib-compile-schemas --strict --dry-run src/schemas

test-shell:
	tests/shell/run.sh

screenshot:
	tests/shell/run.sh readme

pack:
	tests/shell/pack.sh $(DIST)

install: pack
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf $(DIST) tests/out mac/.build

mac-test:
	cd mac && swift test

mac-app:
	mac/bundle.sh

mac-zip: mac-app
	rm -f $(DIST)/oh-my-usage.zip
	ditto -c -k --keepParent $(DIST)/oh-my-usage.app $(DIST)/oh-my-usage.zip

mac-install: mac-app
	pkill -x OhMyUsage || true
	mkdir -p ~/Applications
	rm -rf ~/Applications/oh-my-usage.app
	cp -R $(DIST)/oh-my-usage.app ~/Applications/oh-my-usage.app
	open ~/Applications/oh-my-usage.app
