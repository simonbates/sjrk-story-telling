/*
Copyright 2017-2019 OCAD University
Licensed under the New BSD license. You may not use this file except in compliance with this licence.
You may obtain a copy of the BSD License at
https://raw.githubusercontent.com/fluid-project/sjrk-story-telling/master/LICENSE.txt
*/

"use strict";

var fluid = require("infusion");
var uuidv1 = require("uuid/v1");
var fse = require("fs-extra");
var path = require("path");
var jo = require("jpeg-autorotate");
require("kettle");

var sjrk = fluid.registerNamespace("sjrk");

fluid.defaults("sjrk.storyTelling.server.browseStoriesHandler", {
    gradeNames: "kettle.request.http",
    invokers: {
        handleRequest: {
            funcName: "sjrk.storyTelling.server.handleBrowseStories",
            args: ["{request}", "{server}.viewDataSource"]
        }
    }
});

sjrk.storyTelling.server.handleBrowseStories = function (request, viewDatasource) {
    var promise = viewDatasource.get({directViewId: "storiesById"});
    promise.then(function (response) {
        var extracted = sjrk.storyTelling.server.browseStoriesHandler.extractFromCouchResponse(response);
        var responseAsJSON = JSON.stringify(extracted);
        request.events.onSuccess.fire(responseAsJSON);
    }, function (error) {
        var errorAsJSON = JSON.stringify(error);
        request.events.onError.fire({
            isError: true,
            message: errorAsJSON
        });
    });

};

sjrk.storyTelling.server.browseStoriesHandler.extractFromCouchResponse = function (response) {
    var storyBrowse = {
        totalResults: response.total_rows,
        offset: response.offset,
        stories: {}
    };

    fluid.each(response.rows, function (storyDoc) {
        var story = storyDoc.value;

        var contentTypes = {};

        fluid.each(story.content, function (contentBlock) {
            contentTypes[contentBlock.blockType] = true;
        });

        story.contentTypes = fluid.keys(contentTypes);

        story = fluid.censorKeys(story, ["content"]);

        storyBrowse.stories[storyDoc.id] = story;

    });

    return storyBrowse;
};


fluid.defaults("sjrk.storyTelling.server.getStoryHandler", {
    gradeNames: "kettle.request.http",
    invokers: {
        handleRequest: {
            funcName: "sjrk.storyTelling.server.handleGetStory",
            args: ["{request}", "{server}.storyDataSource", "{server}.options.secureConfig.uploadedFilesHandlerPath"]
        }
    }
});

sjrk.storyTelling.server.handleGetStory = function (request, dataSource, uploadedFilesHandlerPath) {
    var id = request.req.params.id;
    var promise = dataSource.get({directStoryId: id});

    promise.then(function (response) {

        fluid.transform(response.content, function (block) {
            if (block.blockType === "image") {
                if (block.imageUrl) {
                    block.imageUrl = uploadedFilesHandlerPath + "/" + block.imageUrl;
                }
                return block;
            } else if (block.blockType === "audio" || block.blockType === "video") {
                if (block.mediaUrl) {
                    block.mediaUrl = uploadedFilesHandlerPath + "/" + block.mediaUrl;
                }
                return block;
            }
        });

        var responseAsJSON = JSON.stringify(response);
        request.events.onSuccess.fire(responseAsJSON);
    }, function (error) {
        var errorAsJSON = JSON.stringify(error);
        request.events.onError.fire({
            isError: true,
            message: errorAsJSON
        });
    });
};

fluid.defaults("sjrk.storyTelling.server.saveStoryWithBinariesHandler", {
    gradeNames: "kettle.request.http",
    requestMiddleware: {
        "saveStoryWithBinaries": {
            middleware: "{server}.saveStoryWithBinaries"
        }
    },
    invokers: {
        handleRequest: {
            funcName: "sjrk.storyTelling.server.handleSaveStoryWithBinaries",
            args: ["{arguments}.0", "{server}.storyDataSource", "{server}.options.globalConfig.authoringEnabled"]
        }
    }
});

sjrk.storyTelling.server.handleSaveStoryWithBinaries = function (request, dataSource, authoringEnabled) {
    if (authoringEnabled) {
        var rotateImagePromises = [];

        // rotate any images based on their EXIF data, if present
        fluid.each(request.req.files.file, function (singleFile) {
            if (singleFile.mimetype && singleFile.mimetype.indexOf("image") === 0) {
                rotateImagePromises.push(sjrk.storyTelling.server.rotateImageFromExif(singleFile));
            }
        });

        fluid.promise.sequence(rotateImagePromises).then(function () {
            var storyModel = JSON.parse(request.req.body.model);
            var binaryRenameMap = sjrk.storyTelling.server.buildBinaryRenameMap(storyModel.content, request.req.files.file);

            sjrk.storyTelling.server.saveStoryToDatabase(dataSource, binaryRenameMap, storyModel, request.events.onSuccess, request.events.onError);
        }, function (error) {
            request.events.onError.fire({
                errorCode: error.errorCode,
                isError: true,
                message: error.message || "Unknown error in image rotation."
            });
        });
    } else {
        request.events.onError.fire({
            isError: true,
            message: "Saving is currently disabled."
        });
    }
};

// Persist the story model to couch, with the updated
// references to where the binaries are saved
sjrk.storyTelling.server.saveStoryToDatabase = function (dataSource, binaryRenameMap, storyModel, successEvent, failureEvent) {
    var id = uuidv1();

    dataSource.set({directStoryId: id}, storyModel).then(function (response) {
        response.binaryRenameMap = binaryRenameMap;
        successEvent.fire(JSON.stringify(response));
    }, function (error) {
        failureEvent.fire({
            isError: true,
            message: error.reason || "Unspecified server error saving story to database."
        });
    });
};

// Update any media URLs to refer to the changed file names
sjrk.storyTelling.server.buildBinaryRenameMap = function (blocks, files) {
    // key-value pairs of original filename : generated filename
    // this is used primarily by tests, but may be of use
    // to client-side components too
    var binaryRenameMap = {};

    fluid.each(blocks, function (block) {
        if (block.blockType === "image" || block.blockType === "audio" || block.blockType === "video") {
            if (block.fileDetails) {
                // Look for the uploaded file matching this block
                var mediaFile = fluid.find_if(files, function (file) {
                    return file.originalname === block.fileDetails.name;
                });

                // If we find a match, update the media URL. If not, clear it.
                if (mediaFile) {
                    sjrk.storyTelling.server.setMediaBlockUrl(block, mediaFile.filename);
                    binaryRenameMap[mediaFile.originalname] = mediaFile.filename;
                } else {
                    sjrk.storyTelling.server.setMediaBlockUrl(block, null);
                }
            } else {
                sjrk.storyTelling.server.setMediaBlockUrl(block, null);
            }
        }
    });

    return binaryRenameMap;
};

// Rotates an image to be oriented based on its EXIF orientation data, if present
sjrk.storyTelling.server.rotateImageFromExif = function (file, options) {
    var togo = fluid.promise();

    try {
        // ensure the file is present and we have all permissions
        fse.accessSync(file.path);

        // jpeg-autorotate will crash if the `options` arg is undefined
        options = options || {};

        jo.rotate(file.path, options).then(function (rotatedFile) {
            fse.writeFileSync(file.path, rotatedFile.buffer);
            togo.resolve(rotatedFile);
        }, function (error) {
            // if the error code is an "acceptable" error, resolve the promise after all
            if (error.code && (
                error.code === jo.errors.read_exif ||
                error.code === jo.errors.no_orientation ||
                error.code === jo.errors.correct_orientation)) {
                togo.resolve();
            } else {
                fluid.log(fluid.logLevel.WARN, "Image rotation failed for file " + file.path + ": " + error.message);

                togo.reject({
                    errorCode: error.code,
                    isError: true,
                    message: error.message
                });
            }
        });
    } catch (error) {
        togo.reject(error);
    }

    return togo;
};

sjrk.storyTelling.server.setMediaBlockUrl = function (block, url) {
    if (block.blockType === "image") {
        block.imageUrl = url;
    } else if (block.blockType === "audio" || block.blockType === "video") {
        block.mediaUrl = url;
    }
};

fluid.defaults("sjrk.storyTelling.server.deleteStoryHandler", {
    gradeNames: "kettle.request.http",
    requestMiddleware: {
        "basicAuth": {
            middleware: "{server}.basicAuth"
        }
    },
    invokers: {
        handleRequest: {
            funcName: "sjrk.storyTelling.server.handleDeleteStory",
            args: ["{arguments}.0"] // request
        },
        deleteStoryFromCouch: {
            funcName: "sjrk.storyTelling.server.deleteStoryFromCouch",
            args: [
                "{that}",
                "{arguments}.0", // storyId
                "{server}.deleteStoryDataSource",
                "{server}.storyDataSource"
            ]
        },
        deleteStoryFiles: {
            funcName: "sjrk.storyTelling.server.deleteStoryFiles",
            args: ["{that}", "{arguments}.0"] // storyContent
        },
        deleteSingleFileRecoverable: {
            funcName: "sjrk.storyTelling.server.deleteSingleFileRecoverable",
            args: [
                "{arguments}.0", // fileName
                "{server}.options.secureConfig.deletedFilesRecoveryPath",
                "{server}.options.secureConfig.uploadedFilesHandlerPath"
            ]
        }
    }
});

sjrk.storyTelling.server.handleDeleteStory = function (request) {
    var promise = request.deleteStoryFromCouch(request.req.params.id);

    promise.then(function () {
        request.events.onSuccess.fire({
            message: "DELETE request received successfully for story with id: " + request.req.params.id
        });
    }, function (error) {
        var errorAsJSON = JSON.stringify(error);
        request.events.onError.fire({
            isError: true,
            message: errorAsJSON
        });
    });
};

sjrk.storyTelling.server.deleteStoryFromCouch = function (handlerComponent, storyId, deleteStoryDataSource, getStoryDataSource) {
    var promise = fluid.promise();

    var getPromise = getStoryDataSource.get({
        directStoryId: storyId
    });

    getPromise.then(function (response) {
        if (response.content) {
            handlerComponent.deleteStoryFiles(response.content);
        }

        var deletePromise = deleteStoryDataSource.set({
            directStoryId: storyId,
            directRevisionId: response._rev
        });

        deletePromise.then(function (response) {
            promise.resolve(response);
        }, function (error) {
            promise.reject({
                isError: true,
                message: error
            });
        });
    }, function (error) {
        promise.reject({
            isError: true,
            message: error
        });
    });

    return promise;
};

sjrk.storyTelling.server.deleteStoryFiles = function (handlerComponent, storyContent) {
    var filesToDelete = [];

    fluid.each(storyContent, function (block) {
        var blockFileName = "";

        if (block.blockType === "image") {
            blockFileName = block.imageUrl;
        } else if (block.blockType === "audio" || block.blockType === "video") {
            blockFileName = block.mediaUrl;
        }

        if (sjrk.storyTelling.server.isValidMediaFilename(blockFileName)) {
            filesToDelete.push(blockFileName);
        } else {
            fluid.log("Invalid filename:", blockFileName);
        }
    });

    // remove duplicate entries so we don't try to delete already-deleted files
    filesToDelete = filesToDelete.filter(function (fileName, index, self) {
        return self.indexOf(fileName) === index;
    });

    fluid.each(filesToDelete, function (fileToDelete) {
        handlerComponent.deleteSingleFileRecoverable(fileToDelete);
    });
};

/*
 * Verifies that a given file name follows the UUID format as laid out in
 * RFC4122. A detailed description of the format can be found here:
 * https://en.wikipedia.org/wiki/Universally_unique_identifier#Format
 */
sjrk.storyTelling.server.isValidMediaFilename = function (fileName) {
    if (fileName && typeof fileName === "string" ) {
        var validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.\w+)?$/;

        return validUuid.test(fileName);
    } else {
        return false;
    }
};

sjrk.storyTelling.server.getServerPathForFile = function (fileName, directoryName) {
    return "." + directoryName + path.sep + fileName;
};

sjrk.storyTelling.server.deleteSingleFileRecoverable = function (fileToDelete, deletedFilesRecoveryPath, uploadedFilesHandlerPath) {
    var recoveryPath = sjrk.storyTelling.server.getServerPathForFile(fileToDelete, deletedFilesRecoveryPath);
    var deletionPath = sjrk.storyTelling.server.getServerPathForFile(fileToDelete, uploadedFilesHandlerPath);

    // move it to the recovery dir and make sure it was moved
    try {
        fse.moveSync(deletionPath, recoveryPath);
        fse.accessSync(recoveryPath, fse.constants.W_OK | fse.constants.R_OK);
        fluid.log("Moved file to recovery dir:", recoveryPath);
    } catch (err) {
        fluid.fail("Error moving file ", deletionPath, " to recovery dir. Error detail: ", err.toString());
    }

    // make sure it's gone from the uploads dir
    try {
        fse.accessSync(deletionPath);
        fluid.fail("File was not deleted:", deletionPath);
    } catch (err) {
        fluid.log("Deleted file:", deletionPath);
    }
};

fluid.defaults("sjrk.storyTelling.server.clientConfigHandler", {
    gradeNames: "kettle.request.http",
    invokers: {
        handleRequest: {
            funcName: "sjrk.storyTelling.server.getClientConfig",
            args: ["{arguments}.0", "{server}.options.globalConfig", "{server}.options.secureConfig"]
        }
    }
});

// Returns a collection of values which are "safe" to share
// with the client side of the application
sjrk.storyTelling.server.getClientConfig = function (request, globalConfig, secureConfig) {
    request.events.onSuccess.fire({
        theme: globalConfig.theme || secureConfig.baseThemeName,
        baseTheme: secureConfig.baseThemeName,
        authoringEnabled: globalConfig.authoringEnabled
    });
};

fluid.defaults("sjrk.storyTelling.server.testsHandler", {
    gradeNames: ["sjrk.storyTelling.server.staticHandlerBase"],
    requestMiddleware: {
        "static": {
            middleware: "{server}.tests"
        }
    }
});

fluid.defaults("sjrk.storyTelling.server.testDataHandler", {
    gradeNames: ["sjrk.storyTelling.server.staticHandlerBase"],
    requestMiddleware: {
        "static": {
            middleware: "{server}.testData"
        }
    }
});

fluid.defaults("sjrk.storyTelling.server.uiHandler", {
    gradeNames: ["sjrk.storyTelling.server.staticHandlerBase"],
    requestMiddleware: {
        "static": {
            middleware: "{server}.ui"
        }
    }
});

fluid.defaults("sjrk.storyTelling.server.themeHandler", {
    gradeNames: ["sjrk.storyTelling.server.staticHandlerBase"],
    requestMiddleware: {
        "baseTheme": {
            middleware: "{server}.baseTheme"
        },
        "currentTheme": {
            middleware: "{server}.currentTheme",
            priority: "before:baseTheme"
        }
    }
});

fluid.defaults("sjrk.storyTelling.server.uploadsHandler", {
    gradeNames: ["sjrk.storyTelling.server.staticHandlerBase"],
    requestMiddleware: {
        "static": {
            middleware: "{server}.uploads"
        }
    }
});

fluid.defaults("sjrk.storyTelling.server.nodeModulesHandler", {
    gradeNames: ["sjrk.storyTelling.server.staticHandlerBase"],
    requestMiddleware: {
        "staticFilter": {
            middleware: "{server}.nodeModulesFilter"
        },
        "static": {
            middleware: "{server}.nodeModules",
            priority: "after:staticFilter"
        }
    }
});