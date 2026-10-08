UUID := omp-usage@ymkthr.github.io
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip

.PHONY: test test-unit test-shell pack install uninstall clean

test: test-unit test-shell

test-unit:
	gjs -m tests/model-test.js
	gjs -m tests/store-test.js
	glib-compile-schemas --strict --dry-run src/schemas

test-shell:
	tests/shell/run.sh

pack:
	tests/shell/pack.sh $(DIST)

install: pack
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf $(DIST) tests/out
