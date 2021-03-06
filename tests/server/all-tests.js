/*
For copyright information, see the AUTHORS.md file in the docs directory of this distribution and at
https://github.com/fluid-project/sjrk-story-telling/blob/master/docs/AUTHORS.md

Licensed under the New BSD license. You may not use this file except in compliance with this licence.
You may obtain a copy of the BSD License at
https://raw.githubusercontent.com/fluid-project/sjrk-story-telling/master/LICENSE.txt
*/

"use strict";

var fluid = require("infusion"),
    kettle = require("kettle");

kettle.loadTestingSupport();

var testIncludes = [
    "./testServerWithBaseTheme.js",
    "./testServer.js",
    "./testServerWithCustomTheme.js",
    "./testServerWithStorage.js",
    "./testServerWithMissingTheme.js"
];

fluid.each(testIncludes, function (path) {
    require(path);
});
