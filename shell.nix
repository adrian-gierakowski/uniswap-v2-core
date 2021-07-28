let
  pkgs = import <nixpkgs> {};
  node = pkgs.nodejs-10_x;
  yarn = pkgs.yarn.override { nodejs = node; };
in
  pkgs.mkShell {
    buildInputs = [pkgs.python node yarn];
  }
